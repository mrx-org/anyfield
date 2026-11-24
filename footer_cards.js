/**
 * Footer card carousel (compact/mobile layout only).
 *
 * The footer is a three-card horizontal scroller with dot tabs; on desktop it is
 * laid out side by side and every interaction here is inert. Elements are looked
 * up on each call rather than cached so pages without a footer simply no-op.
 */

const CARD_COUNT = 3;

/** Compact layout = narrow viewport or the explicit `.compact-mode` toggle. */
export function isCompactLayout() {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(max-width: 768px)').matches ||
        !!document.querySelector('.lab-shell')?.classList.contains('compact-mode');
}

function footerEl() {
    return document.getElementById('slot-footer');
}

/** Scroll the footer to a card. No-op on desktop or when there is no footer. */
export function goToFooterCard(cardIndex) {
    const footer = footerEl();
    if (!footer || !isCompactLayout()) return;
    const i = Math.max(0, Math.min(CARD_COUNT - 1, cardIndex));
    footer.scrollTo({ left: i * (footer.scrollWidth / CARD_COUNT), behavior: 'smooth' });
}

/** Bind dot tabs, scroll tracking and swipe. Safe to call when the footer is absent. */
export function initFooterCards() {
    const footer = footerEl();
    const dots = document.getElementById('footer-card-dots');
    if (!footer || !dots) return;
    const tabEls = dots.querySelectorAll('.footer-card-tab[data-card]');
    if (tabEls.length !== CARD_COUNT) return;

    const updateActive = () => {
        const cardWidth = footer.scrollWidth / CARD_COUNT;
        const idx = Math.round(footer.scrollLeft / cardWidth);
        const i = Math.max(0, Math.min(CARD_COUNT - 1, idx));
        tabEls.forEach((el, k) => el.classList.toggle('active', k === i));
    };
    footer.addEventListener('scroll', updateActive, { passive: true });
    updateActive();

    tabEls.forEach((el, i) => el.addEventListener('click', () => goToFooterCard(i)));

    let dotsStartX = 0;
    dots.addEventListener('touchstart', (e) => {
        if (!isCompactLayout()) return;
        dotsStartX = e.touches[0].clientX;
    }, { passive: true });
    dots.addEventListener('touchend', (e) => {
        if (!isCompactLayout()) return;
        const delta = dotsStartX - e.changedTouches[0].clientX;
        if (Math.abs(delta) <= 40) return;
        const current = Math.round(footer.scrollLeft / (footer.scrollWidth / CARD_COUNT));
        goToFooterCard(current + (delta > 40 ? 1 : -1));
    }, { passive: true });
}
