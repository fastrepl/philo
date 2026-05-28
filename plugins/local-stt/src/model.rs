use hypr_am::AmModel;
use hypr_whisper_local_model::WhisperModel;

pub static SUPPORTED_MODELS: [SupportedSttModel; 3] = [
    SupportedSttModel::Am(AmModel::ParakeetV2),
    SupportedSttModel::Am(AmModel::ParakeetV3),
    SupportedSttModel::Am(AmModel::WhisperLargeV3),
];

#[derive(serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum SttModelType {
    Whispercpp,
    Argmax,
}

#[derive(serde::Serialize, serde::Deserialize, specta::Type)]
pub struct SttModelInfo {
    pub key: SupportedSttModel,
    pub display_name: String,
    pub description: String,
    pub size_bytes: u64,
    pub model_type: SttModelType,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type, Eq, Hash, PartialEq)]
#[serde(untagged)]
pub enum SupportedSttModel {
    Whisper(WhisperModel),
    Am(AmModel),
}

impl std::fmt::Display for SupportedSttModel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SupportedSttModel::Whisper(model) => write!(f, "whisper-{}", model),
            SupportedSttModel::Am(model) => write!(f, "am-{}", model),
        }
    }
}

impl SupportedSttModel {
    pub fn is_available_on_current_platform(&self) -> bool {
        let is_apple_silicon = cfg!(target_arch = "aarch64") && cfg!(target_os = "macos");

        match self {
            SupportedSttModel::Whisper(_) | SupportedSttModel::Am(_) => is_apple_silicon,
        }
    }

    pub fn info(&self) -> SttModelInfo {
        match self {
            SupportedSttModel::Whisper(model) => SttModelInfo {
                key: self.clone(),
                display_name: model.display_name().to_string(),
                description: model.description(),
                size_bytes: model.model_size_bytes(),
                model_type: SttModelType::Whispercpp,
            },
            SupportedSttModel::Am(model) => SttModelInfo {
                key: self.clone(),
                display_name: model.display_name().to_string(),
                description: model.description().to_string(),
                size_bytes: model.model_size_bytes(),
                model_type: SttModelType::Argmax,
            },
        }
    }
}
