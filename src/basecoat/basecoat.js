(function() {
    'use strict';

    const VIEWPORT_ID = 'tmBasecoatToastViewport';

    function escHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function ensureToastViewport(doc) {
        const targetDoc = doc || document;
        let viewport = targetDoc.getElementById(VIEWPORT_ID);
        if (viewport) return viewport;
        viewport = targetDoc.createElement('div');
        viewport.id = VIEWPORT_ID;
        viewport.className = 'bc-toast-viewport';
        targetDoc.body.appendChild(viewport);
        return viewport;
    }

    function removeToast(el) {
        if (!(el instanceof HTMLElement)) return;
        try { el.remove(); } catch (e) {}
    }

    function toast(options) {
        const opts = options && typeof options === 'object' ? options : {};
        const doc = opts.document || document;
        const viewport = ensureToastViewport(doc);
        const el = doc.createElement('div');
        el.className = 'bc-toast';
        el.dataset.variant = String(opts.variant || 'info').trim() || 'info';
        const title = String(opts.title || '').trim();
        const description = String(opts.description || '').trim();
        el.innerHTML = [
            title ? `<div class="bc-toast__title">${escHtml(title)}</div>` : '',
            description ? `<div class="bc-toast__description">${escHtml(description)}</div>` : '',
        ].join('');
        viewport.appendChild(el);
        const duration = Number.isFinite(Number(opts.duration)) ? Math.max(800, Number(opts.duration)) : 2500;
        const timer = setTimeout(() => removeToast(el), duration);
        el.addEventListener('click', () => {
            try { clearTimeout(timer); } catch (e) {}
            removeToast(el);
        });
        return el;
    }

    window.__tmBasecoat = Object.assign(window.__tmBasecoat || {}, {
        ensureToastViewport,
        toast,
        removeToast,
    });
})();
