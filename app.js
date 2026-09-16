(() => {
    'use strict';

    const grid = document.getElementById('imageGrid');
    const characters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let modal = null;
    let statusTimer;

    function randomId() {
        let id = '';
        for (let i = 0; i < 5; i++) id += characters[Math.floor(Math.random() * characters.length)];
        return id;
    }

    function loadThumbnail(card) {
        const img = card.querySelector('img');
        const id = randomId();
        img.onload = () => {
            if (img.naturalWidth > 0 && img.naturalWidth !== 161) {
                card.dataset.id = id;
                card.dataset.loaded = 'true';
                card.classList.add('loaded');
                img.tabIndex = 0;
                img.onload = img.onerror = null;
                detectFormat(card);
            } else {
                loadThumbnail(card);
            }
        };
        img.onerror = () => loadThumbnail(card);
        // As in the original roulette, every card starts its own request
        // immediately. There is no application-level concurrency limit.
        img.src = `https://i.imgur.com/${id}b.png`;
    }

    function downloadButton() {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'download-button';
        button.textContent = '↓ PNG';
        button.title = 'Скачать изображение как PNG';
        button.setAttribute('aria-label', button.title);
        return button;
    }

    function updateDownloadButton(button, format = 'png') {
        const label = format.toUpperCase();
        button.textContent = `${button.disabled ? '…' : '↓'} ${label}`;
        button.title = format === 'gif' ? 'Скачать анимацию как GIF' : 'Скачать изображение как PNG';
        button.setAttribute('aria-label', button.title);
    }

    function setFormat(card, format) {
        if (card.dataset.format === format) return;
        card.dataset.format = format;
        updateDownloadButton(card.querySelector('.download-button'), format);
        if (format === 'gif') {
            const img = card.querySelector('img');
            const thumbnail = img.src;
            img.onerror = () => {
                img.onerror = null;
                img.src = thumbnail;
            };
            // Square thumbnails are still images. Use the original GIF to animate.
            img.src = `https://i.imgur.com/${card.dataset.id}.gif`;
        }
        card.dispatchEvent(new Event('formatchange'));
    }

    function detectFormat(card) {
        if (card.dataset.format) return Promise.resolve(card.dataset.format);
        if (card.formatRequest) return card.formatRequest;
        const request = (async () => {
            try {
                const response = await fetch(`https://i.imgur.com/${card.dataset.id}.gif`, {
                    method: 'HEAD', mode: 'cors'
                });
                if (!response.ok) return;
                if (card.dataset.format) return card.dataset.format;
                const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
                if (type === 'image/gif') setFormat(card, 'gif');
                else if (type.startsWith('image/')) setFormat(card, 'png');
            } catch {
                // Keep the thumbnail usable; the download also checks the actual bytes.
            }
            return card.dataset.format;
        })();
        card.formatRequest = request;
        request.finally(() => { card.formatRequest = null; });
        return request;
    }

    function populateImageGrid() {
        const columns = Math.max(1, Math.floor(window.innerWidth / 160));
        const rows = Math.max(1, Math.ceil(window.innerHeight / 160));
        const fragment = document.createDocumentFragment();
        const cards = [];
        for (let i = 0; i < columns * rows; i++) {
            const card = document.createElement('div');
            card.className = 'image-card';
            const img = document.createElement('img');
            img.alt = '';
            img.setAttribute('aria-label', 'Увеличить изображение');
            img.setAttribute('role', 'button');
            img.decoding = 'async';
            card.append(img, downloadButton());
            fragment.append(card);
            cards.push(card);
        }
        grid.append(fragment);
        cards.forEach(loadThumbnail);
    }

    function loadMoreOnScroll() {
        if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 1000) {
            populateImageGrid();
        }
    }

    function notify(message) {
        const status = document.querySelector('.download-status');
        clearTimeout(statusTimer);
        status.textContent = message;
        statusTimer = setTimeout(() => { status.textContent = ''; }, 8000);
    }

    const downloads = new Set();
    const pendingFiles = new Map();
    const cachedFiles = new Map();
    const maxCachedBytes = 32 * 1024 * 1024;
    let cachedBytes = 0;

    async function prepareDownload(card) {
        const id = card.dataset.id;
        if (cachedFiles.has(id)) {
            const file = cachedFiles.get(id);
            cachedFiles.delete(id);
            cachedFiles.set(id, file);
            setFormat(card, file.extension);
            return file;
        }
        if (pendingFiles.has(id)) return pendingFiles.get(id);
        const task = (async () => {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 60000);
            let bitmap;
            let canvas;
            try {
                // Request the original GIF endpoint even if its HEAD probe failed.
                // Imgur may return a different image type; identify the bytes below.
                const extension = card.dataset.format === 'png' ? 'png' : 'gif';
                const response = await fetch(`https://i.imgur.com/${id}.${extension}`, {
                    mode: 'cors', signal: controller.signal, priority: 'high'
                });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const source = await response.blob();
                const header = new Uint8Array(await source.slice(0, 24).arrayBuffer());
                const signature = [137, 80, 78, 71, 13, 10, 26, 10];
                const isPng = header.length >= 24 && signature.every((byte, i) => header[i] === byte);
                const gifSignature = String.fromCharCode(...header.slice(0, 6));
                const isGif = header.length >= 10 && (gifSignature === 'GIF87a' || gifSignature === 'GIF89a');
                let blob;
                if (isGif) {
                    // Never send GIFs through canvas: it would discard all but one frame.
                    blob = source.type === 'image/gif' ? source : new Blob([source], { type: 'image/gif' });
                } else if (isPng) {
                    const dimensions = new DataView(header.buffer);
                    if (dimensions.getUint32(16) === 161 && dimensions.getUint32(20) === 81) {
                        throw new Error('Image unavailable');
                    }
                    // Preserve existing PNG bytes, avoiding image decoding and encoding.
                    blob = source.type === 'image/png' ? source : new Blob([source], { type: 'image/png' });
                } else {
                    bitmap = await createImageBitmap(source);
                    if (bitmap.width === 161 && bitmap.height === 81) throw new Error('Image unavailable');
                    canvas = document.createElement('canvas');
                    canvas.width = bitmap.width;
                    canvas.height = bitmap.height;
                    const context = canvas.getContext('2d');
                    if (!context) throw new Error('Canvas unavailable');
                    context.drawImage(bitmap, 0, 0);
                    blob = await new Promise((resolve, reject) => {
                        canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('PNG conversion failed')), 'image/png');
                    });
                }
                const file = { blob, extension: isGif ? 'gif' : 'png' };
                setFormat(card, file.extension);
                if (blob.size <= maxCachedBytes) {
                    while (cachedFiles.size >= 8 || cachedBytes + blob.size > maxCachedBytes) {
                        const oldest = cachedFiles.keys().next().value;
                        cachedBytes -= cachedFiles.get(oldest).blob.size;
                        cachedFiles.delete(oldest);
                    }
                    cachedFiles.set(id, file);
                    cachedBytes += blob.size;
                }
                return file;
            } finally {
                clearTimeout(timeout);
                bitmap?.close();
                if (canvas) canvas.width = canvas.height = 0;
            }
        })();
        pendingFiles.set(id, task);
        try {
            return await task;
        } finally {
            pendingFiles.delete(id);
        }
    }

    function warmDownload(event) {
        const button = event.target.closest('.download-button');
        if (!button) return;
        const card = button.imageCard || button.closest('.image-card');
        if (card?.dataset.loaded) prepareDownload(card).catch(() => {});
    }

    async function saveImage(card, button) {
        const id = card.dataset.id;
        if (downloads.has(id)) return;
        downloads.add(id);
        button.disabled = true;
        updateDownloadButton(button, card.dataset.format);
        try {
            const file = await prepareDownload(card);
            const url = URL.createObjectURL(file.blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `${id}.${file.extension}`;
            document.body.append(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 60000);
        } catch (error) {
            notify('Не удалось скачать изображение. Проверьте соединение и попробуйте ещё раз. Imgur также может ограничивать скачивание.');
        } finally {
            downloads.delete(id);
            button.disabled = false;
            updateDownloadButton(button, card.dataset.format);
        }
    }

    function openImage(card) {
        if (modal) return;
        const previousFocus = document.activeElement;
        modal = document.createElement('div');
        modal.className = 'modal';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.setAttribute('aria-label', 'Увеличенное изображение');
        const container = document.createElement('div');
        container.className = 'img-container';
        const img = document.createElement('img');
        img.alt = '';
        img.decoding = 'async';
        // Display the cached thumbnail immediately while the original is loading.
        img.src = card.querySelector('img').src;
        const original = new Image();
        original.decoding = 'async';
        original.onload = () => {
            if (original.naturalWidth !== 161) img.src = original.src;
            else notify('Оригинал изображения недоступен.');
        };
        original.onerror = () => notify('Не удалось загрузить оригинал изображения.');
        const link = document.createElement('a');
        link.className = 'imgur-link';
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'Open on Imgur';
        const button = downloadButton();
        button.imageCard = card;
        button.addEventListener('click', () => saveImage(card, button));
        function refreshFormat() {
            const source = `https://i.imgur.com/${card.dataset.id}.${card.dataset.format || 'png'}`;
            if (original.src !== source) original.src = source;
            link.href = source;
            updateDownloadButton(button, card.dataset.format);
        }
        card.addEventListener('formatchange', refreshFormat);
        refreshFormat();
        detectFormat(card);
        container.append(img, link, button);
        modal.append(container);

        function close() {
            card.removeEventListener('formatchange', refreshFormat);
            original.onload = original.onerror = null;
            modal.remove();
            modal = null;
            document.removeEventListener('keydown', onKey);
            previousFocus?.focus({ preventScroll: true });
        }
        function onKey(event) {
            if (event.key === 'Escape') close();
            if (event.key === 'Tab') {
                event.preventDefault();
                (document.activeElement === button ? link : button).focus();
            }
        }
        modal.addEventListener('click', event => {
            if (!event.target.closest('button, a')) close();
        });
        document.addEventListener('keydown', onKey);
        document.body.append(modal);
        button.focus({ preventScroll: true });
    }

    grid.addEventListener('click', event => {
        const card = event.target.closest('.image-card');
        if (!card?.dataset.loaded) return;
        const button = event.target.closest('.download-button');
        if (button) saveImage(card, button);
        else if (event.target.tagName === 'IMG') openImage(card);
    });
    grid.addEventListener('keydown', event => {
        if (event.target.tagName === 'IMG' && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            event.target.click();
        }
    });
    document.addEventListener('pointerover', warmDownload, { passive: true });
    document.addEventListener('pointerdown', warmDownload, { passive: true });
    document.addEventListener('focusin', warmDownload);
    window.addEventListener('scroll', loadMoreOnScroll, { passive: true });
    populateImageGrid();
})();
