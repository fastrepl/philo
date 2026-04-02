import React from "react";

export function useMountEffect(effect: () => void | (() => void),) {
  React.useEffect(effect, [],);
}
