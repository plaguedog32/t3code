/**
 * This fork never reports usage to T3 Code's analytics or relay tracing, and
 * never contacts T3 Connect, whatever the build keys or environment say.
 * Upstream reads its own switches; these sit in front of them so merges touch
 * as little as possible. Annotated `boolean` so the guards stay type-checked.
 */
export const TELEMETRY_ENABLED: boolean = false;

export const T3_CONNECT_ENABLED: boolean = false;
