export const WIDGET_EDIT_REQUEST_EVENT = "philo:widget-edit-request";
export const WIDGET_EDIT_STATE_EVENT = "philo:widget-edit-state";
export const WIDGET_EDIT_SUBMIT_EVENT = "philo:widget-edit-submit";

export interface WidgetEditRequestDetail {
  widgetId: string;
  title: string;
}

export interface WidgetEditStateDetail {
  widgetId: string | null;
  isEditing: boolean;
}

export interface WidgetEditSubmitDetail {
  widgetId: string;
  instruction: string;
}
