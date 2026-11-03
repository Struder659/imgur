(() => {
    'use strict';

    const CELL_WIDTH = 360;
    const CELL_HEIGHT = 310;
    const MAX_SPEED = 280; // Screen pixels per second, including diagonal movement.
    const MIN_ZOOM = 0.35;
    const MAX_ZOOM = 2.25;
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

    function* spiral() {
        let x = 0;
        let y = 0;
        yield [x, y];
        for (let length = 1; ; length++) {
            for (let i = 0; i < length; i++) yield [++x, y];
            for (let i = 0; i < length; i++) yield [x, ++y];
            length++;
            for (let i = 0; i < length; i++) yield [--x, y];
            for (let i = 0; i < length; i++) yield [x, --y];
        }
    }

    class SpaceField {
        constructor({ grid, createCards, isModalOpen }) {
            this.grid = grid;
            this.createCards = createCards;
            this.isModalOpen = isModalOpen;
            this.viewport = document.getElementById('spaceViewport');
            this.world = document.getElementById('spaceWorld');
            this.gallery = document.getElementById('gallery');
            this.toggle = document.getElementById('spaceToggle');
            this.pauseButton = document.getElementById('cameraPause');
            this.cells = new Map();
            this.sources = new WeakSet();
            this.coordinates = spiral();
            this.visibleCells = new Set();
            this.camera = { x: 0, y: 0, zoom: 0.82 };
            this.origin = { x: 0, y: 0 };
            this.targetZoom = this.camera.zoom;
            this.velocity = { x: 0, y: 0 };
            this.pointer = { x: 0, y: 0 };
            this.keys = new Set();
            this.paused = matchMedia('(prefers-reduced-motion: reduce)').matches;
            this.active = false;
            this.frame = 0;
            this.regionKey = '';
            this.tick = this.tick.bind(this);
            this.bindControls();
        }

        assign(source, column, row) {
            const key = `${column},${row}`;
            const seed = Math.abs((Math.imul(column, 73856093) ^ Math.imul(row, 19349663)) | 0);
            this.cells.set(key, {
                source, column, row,
                x: column * CELL_WIDTH - 110 + seed % 51 - 25,
                y: row * CELL_HEIGHT - 100 + (seed >>> 5) % 41 - 20,
                width: 190 + (seed >>> 8) % 61,
                view: null,
                cleanup: null
            });
            this.sources.add(source);
        }

        addSources(cards) {
            for (const card of cards) {
                if (this.sources.has(card)) continue;
                let column, row;
                do {
                    [column, row] = this.coordinates.next().value;
                } while (this.cells.has(`${column},${row}`));
                this.assign(card, column, row);
            }
            this.regionKey = '';
        }

        createView(cell) {
            const source = cell.source;
            const view = source.cloneNode(true);
            view.classList.add('space-card');
            view.sourceCard = source;
            view.style.width = `${cell.width}px`;
            const image = view.querySelector('img');
            const button = view.querySelector('.download-button');
            button.imageCard = source;
            if (!source.dataset.loaded) image.removeAttribute('src');
            function sync() {
                view.classList.toggle('loaded', Boolean(source.dataset.loaded));
                view.dataset.id = source.dataset.id || '';
                view.dataset.format = source.dataset.format || 'png';
                if (source.dataset.loaded && image.src !== source.querySelector('img').src) {
                    image.src = source.querySelector('img').src;
                }
                image.tabIndex = source.dataset.loaded ? 0 : -1;
                const sourceButton = source.querySelector('.download-button');
                const format = (source.dataset.format || 'png').toUpperCase();
                button.textContent = `${button.disabled ? '…' : '↓'} ${format}`;
                button.title = sourceButton.title;
                button.setAttribute('aria-label', sourceButton.getAttribute('aria-label'));
            }
            source.addEventListener('imageupdate', sync);
            source.addEventListener('formatchange', sync);
            cell.cleanup = () => {
                source.removeEventListener('imageupdate', sync);
                source.removeEventListener('formatchange', sync);
            };
            sync();
            cell.view = view;
            return view;
        }

        ensureRegion() {
            const { x, y, zoom } = this.camera;
            const halfWidth = innerWidth / (2 * zoom) + 500;
            const halfHeight = innerHeight / (2 * zoom) + 600;
            const minColumn = Math.floor((x - halfWidth) / CELL_WIDTH);
            const maxColumn = Math.ceil((x + halfWidth) / CELL_WIDTH);
            const minRow = Math.floor((y - halfHeight) / CELL_HEIGHT);
            const maxRow = Math.ceil((y + halfHeight) / CELL_HEIGHT);
            const regionKey = `${minColumn}:${maxColumn}:${minRow}:${maxRow}`;
            if (regionKey === this.regionKey) return;
            this.regionKey = regionKey;

            const needed = new Set();
            const missing = [];
            for (let row = minRow; row <= maxRow; row++) {
                for (let column = minColumn; column <= maxColumn; column++) {
                    const key = `${column},${row}`;
                    needed.add(key);
                    if (!this.cells.has(key)) missing.push([column, row]);
                }
            }
            // Grow the world in every direction. Keep every original card in the
            // gallery; only the offscreen visual copies are detached from the scene.
            if (missing.length) {
                const cards = this.createCards(missing.length);
                cards.forEach((card, index) => this.assign(card, ...missing[index]));
            }
            for (const key of this.visibleCells) {
                if (needed.has(key)) continue;
                const cell = this.cells.get(key);
                cell.cleanup();
                cell.view.remove();
                cell.view = cell.cleanup = null;
            }

            // Rebase CSS coordinates near the camera to retain subpixel precision
            // after very long journeys. World coordinates and image positions persist.
            this.origin.x = Math.round(x / CELL_WIDTH) * CELL_WIDTH;
            this.origin.y = Math.round(y / CELL_HEIGHT) * CELL_HEIGHT;
            const fragment = document.createDocumentFragment();
            for (const key of needed) {
                const cell = this.cells.get(key);
                if (!cell.view) fragment.append(this.createView(cell));
                cell.view.style.transform = `translate3d(${cell.x - this.origin.x}px, ${cell.y - this.origin.y}px, 0)`;
            }
            this.world.append(fragment);
            this.visibleCells = needed;
        }

        render() {
            const { x, y, zoom } = this.camera;
            this.world.style.transform = `translate3d(${innerWidth / 2 - (x - this.origin.x) * zoom}px, ${innerHeight / 2 - (y - this.origin.y) * zoom}px, 0) scale(${zoom})`;
        }

        setActive(active) {
            if (this.active === active) return;
            this.active = active;
            clearTimeout(this.settleTimer);
            this.stopInput();
            this.toggle.setAttribute('aria-pressed', String(active));
            this.toggle.title = active ? 'Вернуться в ленту' : 'Открыть пространство изображений';
            this.pauseButton.hidden = !active;
            this.viewport.inert = !active;
            this.viewport.setAttribute('aria-hidden', String(!active));
            this.gallery.inert = active;
            document.body.classList.remove('space-settled');

            if (active) {
                this.savedScroll = scrollY;
                this.addSources(this.grid.children);
                this.ensureRegion();
                this.render();
                document.body.classList.add('space-mode');
                this.setPaused(this.paused);
                this.viewport.focus({ preventScroll: true });
                this.lastTime = performance.now();
                this.frame = requestAnimationFrame(this.tick);
                this.settleTimer = setTimeout(() => {
                    if (this.active) document.body.classList.add('space-settled');
                }, 720);
            } else {
                cancelAnimationFrame(this.frame);
                this.frame = 0;
                document.body.classList.remove('space-mode', 'space-paused');
                window.scrollTo(0, this.savedScroll || 0);
                this.toggle.focus({ preventScroll: true });
            }
        }

        setPaused(paused) {
            this.paused = paused;
            this.stopInput();
            document.body.classList.toggle('space-paused', this.active && paused);
            this.pauseButton.setAttribute('aria-pressed', String(paused));
            const label = paused ? 'Продолжить движение камеры' : 'Приостановить камеру';
            this.pauseButton.title = `${label} (нажатие колеса мыши)`;
            this.pauseButton.setAttribute('aria-label', label);
        }

        stopInput() {
            this.pointer.x = this.pointer.y = 0;
            this.velocity.x = this.velocity.y = 0;
            this.keys.clear();
            this.drag = null;
        }

        tick(time) {
            if (!this.active) return;
            const dt = Math.min((time - this.lastTime) / 1000, 0.04);
            this.lastTime = time;
            const zooming = Math.abs(this.camera.zoom - this.targetZoom) > 0.0001;
            if (zooming) {
                const zoom = this.camera.zoom + (this.targetZoom - this.camera.zoom) * (1 - Math.exp(-12 * dt));
                if (this.zoomAnchor) {
                    this.camera.x = this.zoomAnchor.worldX - this.zoomAnchor.screenX / zoom;
                    this.camera.y = this.zoomAnchor.worldY - this.zoomAnchor.screenY / zoom;
                }
                this.camera.zoom = zoom;
            } else {
                this.camera.zoom = this.targetZoom;
                this.zoomAnchor = null;
            }

            let vx = 0;
            let vy = 0;
            if (!this.paused && !this.isModalOpen() && !document.hidden && !zooming) {
                if (this.drag?.moved) {
                    vx = (this.drag.targetX - this.camera.x) * this.camera.zoom * 10;
                    vy = (this.drag.targetY - this.camera.y) * this.camera.zoom * 10;
                } else if (!this.drag) {
                    vx = ((this.keys.has('ArrowRight') ? 1 : 0) - (this.keys.has('ArrowLeft') ? 1 : 0)) * MAX_SPEED;
                    vy = ((this.keys.has('ArrowDown') ? 1 : 0) - (this.keys.has('ArrowUp') ? 1 : 0)) * MAX_SPEED;
                    if (!vx && !vy) {
                        vx = this.pointer.x * MAX_SPEED;
                        vy = this.pointer.y * MAX_SPEED;
                    }
                }
            }
            const length = Math.hypot(vx, vy);
            if (length > MAX_SPEED) {
                vx *= MAX_SPEED / length;
                vy *= MAX_SPEED / length;
            }
            const blocked = this.paused || this.isModalOpen() || document.hidden || zooming;
            const smoothing = 1 - Math.exp(-10 * dt);
            this.velocity.x = blocked ? 0 : this.velocity.x + (vx - this.velocity.x) * smoothing;
            this.velocity.y = blocked ? 0 : this.velocity.y + (vy - this.velocity.y) * smoothing;
            this.camera.x += this.velocity.x * dt / this.camera.zoom;
            this.camera.y += this.velocity.y * dt / this.camera.zoom;
            this.ensureRegion();
            this.render();
            this.frame = requestAnimationFrame(this.tick);
        }

        bindControls() {
            const viewport = this.viewport;
            this.toggle.addEventListener('click', () => this.setActive(!this.active));
            this.pauseButton.addEventListener('click', () => this.setPaused(!this.paused));
            viewport.addEventListener('pointermove', event => {
                if (this.paused || this.isModalOpen()) return;
                if (this.drag && this.drag.id === event.pointerId) {
                    const dx = event.clientX - this.drag.startX;
                    const dy = event.clientY - this.drag.startY;
                    if (Math.hypot(dx, dy) > 6) this.drag.moved = true;
                    if (this.drag.moved) {
                        this.drag.targetX = this.drag.cameraX - dx / this.camera.zoom;
                        this.drag.targetY = this.drag.cameraY - dy / this.camera.zoom;
                        viewport.setPointerCapture(event.pointerId);
                    }
                } else if (event.pointerType === 'mouse') {
                    const deadZone = value => Math.sign(value) * Math.max(0, (Math.abs(value) - 0.18) / 0.82);
                    this.pointer.x = deadZone(clamp((event.clientX / innerWidth - 0.5) * 2, -1, 1));
                    this.pointer.y = deadZone(clamp((event.clientY / innerHeight - 0.5) * 2, -1, 1));
                }
            });
            viewport.addEventListener('pointerleave', () => {
                this.pointer.x = this.pointer.y = 0;
            });
            viewport.addEventListener('pointerdown', event => {
                if (event.button === 1) {
                    event.preventDefault();
                    this.setPaused(!this.paused);
                    return;
                }
                if (event.button !== 0 || this.paused || event.target.closest('button, a')) return;
                this.drag = {
                    id: event.pointerId, startX: event.clientX, startY: event.clientY,
                    cameraX: this.camera.x, cameraY: this.camera.y,
                    targetX: this.camera.x, targetY: this.camera.y, moved: false
                };
            });
            const finishDrag = event => {
                if (this.drag?.moved) this.suppressClickUntil = performance.now() + 200;
                this.drag = null;
                this.pointer.x = this.pointer.y = 0;
                this.velocity.x = this.velocity.y = 0;
                if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
            };
            viewport.addEventListener('pointerup', finishDrag);
            viewport.addEventListener('pointercancel', finishDrag);
            viewport.addEventListener('click', event => {
                if (performance.now() < (this.suppressClickUntil || 0)) {
                    event.preventDefault();
                    event.stopPropagation();
                }
            }, true);
            for (const name of ['mousedown', 'auxclick']) {
                viewport.addEventListener(name, event => { if (event.button === 1) event.preventDefault(); });
            }
            viewport.addEventListener('dragstart', event => event.preventDefault());
            viewport.addEventListener('wheel', event => {
                event.preventDefault();
                const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? innerHeight : 1;
                const delta = clamp(event.deltaY * unit, -160, 160);
                const screenX = event.clientX - innerWidth / 2;
                const screenY = event.clientY - innerHeight / 2;
                this.zoomAnchor = {
                    screenX, screenY,
                    worldX: this.camera.x + screenX / this.camera.zoom,
                    worldY: this.camera.y + screenY / this.camera.zoom
                };
                this.targetZoom = clamp(this.targetZoom * Math.exp(-delta * 0.0018), MIN_ZOOM, MAX_ZOOM);
                this.velocity.x = this.velocity.y = 0;
            }, { passive: false });
            document.addEventListener('keydown', event => {
                if (!this.active || this.isModalOpen() || event.target.closest('button, a')) return;
                if (event.key.startsWith('Arrow')) {
                    event.preventDefault();
                    this.keys.add(event.key);
                } else if (event.key === 'Escape') {
                    this.setActive(false);
                } else if (event.key === ' ' && event.target === viewport) {
                    event.preventDefault();
                    this.setPaused(!this.paused);
                }
            });
            document.addEventListener('keyup', event => this.keys.delete(event.key));
            window.addEventListener('blur', () => this.stopInput());
            document.addEventListener('visibilitychange', () => this.stopInput());
            window.addEventListener('resize', () => { this.regionKey = ''; });
        }
    }

    window.SpaceField = SpaceField;
})();
