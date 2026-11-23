// One toaster per page: short notices bottom right (e.g. "Kopiert"). Shown by
// components/Toaster.svelte, which the website and the MCP App shell mount once.
import { createToaster } from "@skeletonlabs/skeleton-svelte";

export const toaster = createToaster({ placement: "bottom-end", duration: 2000 });
