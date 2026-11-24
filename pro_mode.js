/**
 * Pro/debug mode flag, shared by every module that gates UI on it.
 *
 * `index.html` (and `viewer.html`) additionally set `window.pro` and toggle the
 * `.pro-user` class on `<html>`; that class is load-bearing CSS
 * (`no_field.css`, `scan_module.css`) so those writes stay. This helper is the
 * only thing that should *read* the flag.
 *
 * The URL is re-parsed as a fallback because module evaluation can happen before
 * the page sets `window.pro` — `paper_plot/launch.js` binds its button that
 * early.
 */
export function isProUser() {
    if (typeof window !== 'undefined' && window.pro) return true;
    if (typeof window === 'undefined' || !window.location?.search) return false;
    // Byte-identical to the ?pro= parse in app_bootstrap.js and viewer.html, and
    // deliberately so. `|` binds looser than the anchors, so this reads as
    // `(^1) | (true) | (yes$)`: anything starting with 1, containing "true" or ending
    // in "yes" turns pro mode on, which admits ?pro=1abc, ?pro=untrue and ?pro=truthy.
    // Left as-is because pro mode gates UI affordances, not access -- see the Pro mode
    // section of insights/SPEC_no_field.md. All three copies must change together.
    return /^1|true|yes$/i.test(new URLSearchParams(window.location.search).get('pro') || '');
}
