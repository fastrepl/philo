use serde::Serialize;
use std::ffi::CStr;
use std::os::raw::c_char;
use std::ptr;
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::Duration;
use tauri::AppHandle;

use objc::declare::ClassDecl;
use objc::runtime::{Class, Object, Protocol, Sel};

const CL_AUTHORIZATION_STATUS_NOT_DETERMINED: i32 = 0;
const CL_AUTHORIZATION_STATUS_RESTRICTED: i32 = 1;
const CL_AUTHORIZATION_STATUS_DENIED: i32 = 2;
const CL_AUTHORIZATION_STATUS_AUTHORIZED_ALWAYS: i32 = 3;
const CL_AUTHORIZATION_STATUS_AUTHORIZED_WHEN_IN_USE: i32 = 4;
const LOCATION_SETUP_TIMEOUT: Duration = Duration::from_secs(2);
const LOCATION_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

#[repr(C)]
struct CLLocationCoordinate2D {
    latitude: f64,
    longitude: f64,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCurrentPosition {
    pub latitude: f64,
    pub longitude: f64,
    pub accuracy: f64,
}

struct ActiveLocationRequest {
    manager: usize,
    delegate: usize,
    sender: mpsc::Sender<Result<NativeCurrentPosition, String>>,
}

fn active_location_request() -> &'static Mutex<Option<ActiveLocationRequest>> {
    static ACTIVE: OnceLock<Mutex<Option<ActiveLocationRequest>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(None))
}

fn location_delegate_class() -> Result<&'static Class, String> {
    static CLASS: OnceLock<Result<&'static Class, String>> = OnceLock::new();
    CLASS
        .get_or_init(|| {
            let superclass = Class::get("NSObject")
                .ok_or_else(|| "NSObject class is unavailable.".to_string())?;
            let mut decl = ClassDecl::new("PhiloLocationDelegate", superclass)
                .ok_or_else(|| "Failed to register location delegate class.".to_string())?;
            let protocol = Protocol::get("CLLocationManagerDelegate")
                .ok_or_else(|| "CLLocationManagerDelegate protocol is unavailable.".to_string())?;
            decl.add_protocol(protocol);
            unsafe {
                decl.add_method(
                    sel!(locationManagerDidChangeAuthorization:),
                    location_manager_did_change_authorization
                        as extern "C" fn(&Object, Sel, *mut Object),
                );
                decl.add_method(
                    sel!(locationManager:didUpdateLocations:),
                    location_manager_did_update_locations
                        as extern "C" fn(&Object, Sel, *mut Object, *mut Object),
                );
                decl.add_method(
                    sel!(locationManager:didFailWithError:),
                    location_manager_did_fail_with_error
                        as extern "C" fn(&Object, Sel, *mut Object, *mut Object),
                );
            }
            Ok(decl.register())
        })
        .clone()
}

fn request_location(manager: *mut Object) {
    unsafe {
        let _: () = msg_send![manager, requestLocation];
    }
}

fn current_authorization_status(manager: *mut Object) -> i32 {
    unsafe { msg_send![manager, authorizationStatus] }
}

fn release_object(object: usize) {
    if object == 0 {
        return;
    }
    unsafe {
        let _: () = msg_send![object as *mut Object, release];
    }
}

fn take_active_location_request() -> Option<ActiveLocationRequest> {
    active_location_request().lock().ok()?.take()
}

fn finish_active_location_request(result: Result<NativeCurrentPosition, String>) {
    let Some(request) = take_active_location_request() else {
        return;
    };

    unsafe {
        let manager = request.manager as *mut Object;
        let _: () = msg_send![manager, stopUpdatingLocation];
        let _: () = msg_send![manager, setDelegate: ptr::null_mut::<Object>()];
    }

    release_object(request.manager);
    release_object(request.delegate);
    let _ = request.sender.send(result);
}

fn clear_active_location_request() {
    let Some(request) = take_active_location_request() else {
        return;
    };

    unsafe {
        let manager = request.manager as *mut Object;
        let _: () = msg_send![manager, stopUpdatingLocation];
        let _: () = msg_send![manager, setDelegate: ptr::null_mut::<Object>()];
    }

    release_object(request.manager);
    release_object(request.delegate);
}

fn nsstring_to_string(string: *mut Object) -> String {
    if string.is_null() {
        return String::new();
    }

    unsafe {
        let utf8: *const c_char = msg_send![string, UTF8String];
        if utf8.is_null() {
            return String::new();
        }
        CStr::from_ptr(utf8).to_string_lossy().into_owned()
    }
}

fn start_location_request(
    sender: mpsc::Sender<Result<NativeCurrentPosition, String>>,
) -> Result<(), String> {
    if active_location_request()
        .lock()
        .map_err(|_| "Location request state is poisoned.".to_string())?
        .is_some()
    {
        return Err("A location request is already in progress.".to_string());
    }

    let manager_class = Class::get("CLLocationManager")
        .ok_or_else(|| "CLLocationManager class is unavailable.".to_string())?;
    let location_services_enabled: bool =
        unsafe { msg_send![manager_class, locationServicesEnabled] };
    if !location_services_enabled {
        return Err("Location Services are disabled in macOS settings.".to_string());
    }

    let delegate_class = location_delegate_class()?;
    let manager: *mut Object = unsafe { msg_send![manager_class, new] };
    if manager.is_null() {
        return Err("Failed to create CLLocationManager.".to_string());
    }

    let delegate: *mut Object = unsafe { msg_send![delegate_class, new] };
    if delegate.is_null() {
        release_object(manager as usize);
        return Err("Failed to create CLLocationManager delegate.".to_string());
    }

    unsafe {
        let _: () = msg_send![manager, setDelegate: delegate];
        let _: () = msg_send![manager, setDesiredAccuracy: 100.0f64];
    }

    active_location_request()
        .lock()
        .map_err(|_| "Location request state is poisoned.".to_string())?
        .replace(ActiveLocationRequest {
            manager: manager as usize,
            delegate: delegate as usize,
            sender,
        });

    match current_authorization_status(manager) {
        CL_AUTHORIZATION_STATUS_AUTHORIZED_ALWAYS
        | CL_AUTHORIZATION_STATUS_AUTHORIZED_WHEN_IN_USE => {
            request_location(manager);
        }
        CL_AUTHORIZATION_STATUS_NOT_DETERMINED => unsafe {
            let _: () = msg_send![manager, requestWhenInUseAuthorization];
        },
        CL_AUTHORIZATION_STATUS_RESTRICTED | CL_AUTHORIZATION_STATUS_DENIED => {
            finish_active_location_request(Err(
                "Location access is denied for Philo. Enable it in System Settings > Privacy & Security > Location Services."
                    .to_string(),
            ));
        }
        _ => {
            finish_active_location_request(Err(
                "Philo could not determine the current location authorization state.".to_string(),
            ));
        }
    }

    Ok(())
}

pub fn get_current_position(app: AppHandle) -> Result<NativeCurrentPosition, String> {
    let (result_sender, result_receiver) = mpsc::channel();
    let (setup_sender, setup_receiver) = mpsc::channel();

    app.run_on_main_thread(move || {
        let _ = setup_sender.send(start_location_request(result_sender));
    })
    .map_err(|e| e.to_string())?;

    setup_receiver
        .recv_timeout(LOCATION_SETUP_TIMEOUT)
        .map_err(|_| "Timed out starting the native location request.".to_string())??;

    match result_receiver.recv_timeout(LOCATION_REQUEST_TIMEOUT) {
        Ok(result) => result,
        Err(_) => {
            let _ = app.run_on_main_thread(clear_active_location_request);
            Err("Timed out waiting for macOS to provide the current location.".to_string())
        }
    }
}

extern "C" fn location_manager_did_change_authorization(
    _this: &Object,
    _cmd: Sel,
    manager: *mut Object,
) {
    match current_authorization_status(manager) {
        CL_AUTHORIZATION_STATUS_AUTHORIZED_ALWAYS
        | CL_AUTHORIZATION_STATUS_AUTHORIZED_WHEN_IN_USE => {
            request_location(manager);
        }
        CL_AUTHORIZATION_STATUS_RESTRICTED | CL_AUTHORIZATION_STATUS_DENIED => {
            finish_active_location_request(Err(
                "Location access is denied for Philo. Enable it in System Settings > Privacy & Security > Location Services."
                    .to_string(),
            ));
        }
        _ => {}
    }
}

extern "C" fn location_manager_did_update_locations(
    _this: &Object,
    _cmd: Sel,
    _manager: *mut Object,
    locations: *mut Object,
) {
    if locations.is_null() {
        finish_active_location_request(Err(
            "macOS returned an empty location response.".to_string()
        ));
        return;
    }

    unsafe {
        let location: *mut Object = msg_send![locations, lastObject];
        if location.is_null() {
            finish_active_location_request(Err(
                "macOS returned an empty location response.".to_string()
            ));
            return;
        }

        let coordinate: CLLocationCoordinate2D = msg_send![location, coordinate];
        let accuracy: f64 = msg_send![location, horizontalAccuracy];
        finish_active_location_request(Ok(NativeCurrentPosition {
            latitude: coordinate.latitude,
            longitude: coordinate.longitude,
            accuracy,
        }));
    }
}

extern "C" fn location_manager_did_fail_with_error(
    _this: &Object,
    _cmd: Sel,
    _manager: *mut Object,
    error: *mut Object,
) {
    if error.is_null() {
        finish_active_location_request(Err(
            "macOS failed to provide the current location.".to_string()
        ));
        return;
    }

    unsafe {
        let description: *mut Object = msg_send![error, localizedDescription];
        let message = nsstring_to_string(description);
        if message.trim().is_empty() {
            finish_active_location_request(Err(
                "macOS failed to provide the current location.".to_string()
            ));
        } else {
            finish_active_location_request(Err(message));
        }
    }
}
