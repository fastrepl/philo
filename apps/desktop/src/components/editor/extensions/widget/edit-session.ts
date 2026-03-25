import { useSyncExternalStore, } from "react";

export interface WidgetEditSession {
  widgetId: string;
  title: string;
}

type WidgetEditController = {
  submitInstruction: (instruction: string,) => Promise<void> | void;
};

type WidgetEditSessionState = {
  isBuilding: boolean;
  session: WidgetEditSession | null;
};

const listeners = new Set<() => void>();
const controllers = new Map<string, WidgetEditController>();

let state: WidgetEditSessionState = {
  isBuilding: false,
  session: null,
};

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void,) {
  listeners.add(listener,);
  return () => listeners.delete(listener,);
}

function getSnapshot() {
  return state;
}

export function useWidgetEditSessionStore() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot,);
}

export function requestWidgetEdit(session: WidgetEditSession,) {
  state = {
    isBuilding: false,
    session,
  };
  emit();
}

export function clearWidgetEditSession(widgetId?: string | null,) {
  if (widgetId && state.session?.widgetId !== widgetId) {
    return;
  }

  if (!state.session && !state.isBuilding) {
    return;
  }

  state = {
    isBuilding: false,
    session: null,
  };
  emit();
}

export function setWidgetEditBuildState(widgetId: string, isBuilding: boolean,) {
  if (state.session?.widgetId !== widgetId || state.isBuilding === isBuilding) {
    return;
  }

  state = {
    ...state,
    isBuilding,
  };
  emit();
}

export function registerWidgetEditController(widgetId: string, controller: WidgetEditController,) {
  controllers.set(widgetId, controller,);

  return () => {
    if (controllers.get(widgetId,) === controller) {
      controllers.delete(widgetId,);
    }
  };
}

export async function submitWidgetEditInstruction(instruction: string,) {
  const session = state.session;
  if (!session) return false;

  const controller = controllers.get(session.widgetId,);
  if (!controller) return false;

  await controller.submitInstruction(instruction,);
  return true;
}
