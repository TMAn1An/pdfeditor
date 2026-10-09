import { useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from 'react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import type { PageInfo, QuarterTurn } from '../../types/project';
import { viewPointToNorm, viewSize, type Point } from '../../lib/pdf/coords';

/**
 * Renders PDF pages with PDF.js onto canvases and places a separate,
 * transparent interaction layer above each page.
 *
 * The interaction layer is laid out in *unrotated display space* (the page as
 * a normal viewer shows it) and rotated with CSS to follow the user's view
 * rotation, so field boxes positioned with percentages stay glued to the page
 * at every zoom level and rotation. Pointer positions are converted back to
 * normalized page coordinates with `viewPointToNorm`.
 */

export interface PageOverlayContext {
  pageNumber: number;
  info: PageInfo;
  scale: number;
  viewRotation: QuarterTurn;
  /** Convert a pointer position (client coordinates) to normalized page coordinates. */
  toNorm: (clientX: number, clientY: number) => Point;
  /** The rendered canvas (for sampling colours). May be null before rendering. */
  getCanvas: () => HTMLCanvasElement | null;
}

export interface PdfViewerHandle {
  scrollToPage: (page: number) => void;
}

interface PdfViewerProps {
  doc: PDFDocumentProxy;
  pages: PageInfo[];
  scale: number;
  viewRotation: QuarterTurn;
  overlay?: (ctx: PageOverlayContext) => ReactNode;
  pageBanner?: (pageNumber: number) => ReactNode;
  onCurrentPageChange?: (page: number) => void;
  onContainerResize?: (width: number, height: number) => void;
  handleRef?: Ref<PdfViewerHandle>;
  className?: string;
  ariaLabel?: string;
}

const MAX_CANVAS_PIXELS = 16_000_000;

export function PdfViewer({ doc, pages, scale, viewRotation, overlay, pageBanner, onCurrentPageChange, onContainerResize, handleRef, className, ariaLabel }: PdfViewerProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const pageEls = useRef(new Map<number, HTMLDivElement>());
  const [visible, setVisible] = useState<Set<number>>(new Set([1]));
  const ratios = useRef(new Map<number, number>());

  useImperativeHandle(
    handleRef,
    () => ({
      scrollToPage(page: number) {
        const el = pageEls.current.get(page);
        if (el && scroller.current) scroller.current.scrollTo({ top: el.offsetTop - 16, behavior: 'smooth' });
      },
    }),
    [],
  );

  useEffect(() => {
    const root = scroller.current;
    if (!root) return;
    const ro = new ResizeObserver(() => onContainerResize?.(root.clientWidth, root.clientHeight));
    ro.observe(root);
    onContainerResize?.(root.clientWidth, root.clientHeight);
    return () => ro.disconnect();
  }, [onContainerResize]);

  const observers = useRef<IntersectionObserver[]>([]);
  const currentPageCb = useRef(onCurrentPageChange);
  useEffect(() => {
    currentPageCb.current = onCurrentPageChange;
  }, [onCurrentPageChange]);

  useEffect(() => {
    const root = scroller.current;
    if (!root) return;
    const io = new IntersectionObserver(
      (entries) => {
        setVisible((prev) => {
          const next = new Set(prev);
          for (const e of entries) {
            const n = Number((e.target as HTMLElement).dataset.page);
            if (e.isIntersecting) next.add(n);
            else next.delete(n);
          }
          return next;
        });
      },
      { root, rootMargin: '800px 0px' },
    );
    const io2 = new IntersectionObserver(
      (entries) => {
        for (const e of entries) ratios.current.set(Number((e.target as HTMLElement).dataset.page), e.intersectionRatio);
        let best = 1;
        let bestRatio = -1;
        for (const [n, r] of ratios.current) {
          if (r > bestRatio) {
            best = n;
            bestRatio = r;
          }
        }
        currentPageCb.current?.(best);
      },
      { root, threshold: [0, 0.1, 0.25, 0.5, 0.75, 1] },
    );
    observers.current = [io, io2];
    for (const el of pageEls.current.values()) {
      io.observe(el);
      io2.observe(el);
    }
    return () => {
      io.disconnect();
      io2.disconnect();
      observers.current = [];
    };
  }, []);

  // Pages register their element when it mounts; observe it from then on.
  const register = useCallback((n: number, el: HTMLDivElement | null) => {
    const old = pageEls.current.get(n);
    if (old && old !== el) for (const o of observers.current) o.unobserve(old);
    if (el) {
      pageEls.current.set(n, el);
      for (const o of observers.current) o.observe(el);
    } else {
      pageEls.current.delete(n);
      ratios.current.delete(n);
    }
  }, []);

  return (
    <div ref={scroller} className={`pdf-scroller ${className ?? ''}`} aria-label={ariaLabel ?? 'PDF pages'} tabIndex={-1}>
      <div className="pdf-pages">
        {pages.map((info) => (
          <PageView
            key={info.pageNumber}
            doc={doc}
            info={info}
            scale={scale}
            viewRotation={viewRotation}
            active={visible.has(info.pageNumber)}
            register={register}
            overlay={overlay}
            banner={pageBanner?.(info.pageNumber)}
          />
        ))}
      </div>
    </div>
  );
}

interface PageViewProps {
  doc: PDFDocumentProxy;
  info: PageInfo;
  scale: number;
  viewRotation: QuarterTurn;
  active: boolean;
  register: (n: number, el: HTMLDivElement | null) => void;
  overlay?: (ctx: PageOverlayContext) => ReactNode;
  banner?: ReactNode;
}

function PageView({ doc, info, scale, viewRotation, active, register, overlay, banner }: PageViewProps) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [canvasEl, setCanvasEl] = useState<HTMLCanvasElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rendered, setRendered] = useState(false);
  const size = viewSize(info, scale, viewRotation);
  const layerW = info.displayWidth * scale;
  const layerH = info.displayHeight * scale;

  useEffect(() => {
    register(info.pageNumber, container);
    return () => register(info.pageNumber, null);
  }, [info.pageNumber, register, container]);

  useEffect(() => {
    if (!active) return;
    let task: RenderTask | null = null;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const page = await doc.getPage(info.pageNumber);
        if (cancelled) return;
        let pixelRatio = window.devicePixelRatio || 1;
        const base = page.getViewport({ scale, rotation: (page.rotate + viewRotation) % 360 });
        if (base.width * base.height * pixelRatio * pixelRatio > MAX_CANVAS_PIXELS) {
          pixelRatio = Math.sqrt(MAX_CANVAS_PIXELS / (base.width * base.height));
        }
        const viewport = page.getViewport({ scale: scale * pixelRatio, rotation: (page.rotate + viewRotation) % 360 });
        // Render off-screen, then swap in, so zooming never flashes a blank page.
        const off = document.createElement('canvas');
        off.width = Math.floor(viewport.width);
        off.height = Math.floor(viewport.height);
        task = page.render({ canvas: off, viewport });
        await task.promise;
        if (cancelled) return;
        const canvas = canvasEl;
        if (!canvas) return;
        canvas.width = off.width;
        canvas.height = off.height;
        canvas.getContext('2d')?.drawImage(off, 0, 0);
        off.width = 0;
        off.height = 0;
        setRendered(true);
        setError(null);
      } catch (err) {
        const name = (err as { name?: string })?.name;
        if (name !== 'RenderingCancelledException' && !cancelled) {
          console.warn(`Rendering page ${info.pageNumber} failed`, err);
          setError(`Page ${info.pageNumber} could not be displayed.`);
        }
      }
    }, 60);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      task?.cancel();
    };
  }, [active, doc, info.pageNumber, scale, viewRotation, canvasEl]);

  // Free memory of pages far away from the viewport.
  useEffect(() => {
    if (active) return;
    const t = setTimeout(() => {
      if (canvasEl) {
        canvasEl.width = 0;
        canvasEl.height = 0;
      }
      setRendered(false);
    }, 3000);
    return () => clearTimeout(t);
  }, [active, canvasEl]);

  const toNorm = useCallback(
    (clientX: number, clientY: number) => {
      if (!container) return { x: 0, y: 0 };
      const r = container.getBoundingClientRect();
      return viewPointToNorm(clientX - r.left, clientY - r.top, r.width, r.height, viewRotation);
    },
    [viewRotation, container],
  );
  const getCanvas = useCallback(() => canvasEl, [canvasEl]);

  return (
    <div className="pdf-page-wrap">
      <div className="pdf-page-label" aria-hidden="true">
        Page {info.pageNumber}
      </div>
      {banner}
      <div
        ref={setContainer}
        data-page={info.pageNumber}
        className="pdf-page"
        style={{ width: size.width, height: size.height }}
        role="group"
        aria-label={`Page ${info.pageNumber}`}
      >
        <canvas ref={setCanvasEl} className="pdf-canvas" style={{ width: size.width, height: size.height }} aria-hidden="true" />
        {!rendered && !error && <div className="pdf-page-loading">Loading page {info.pageNumber}…</div>}
        {error && <div className="pdf-page-error">{error}</div>}
        {overlay && (
          <div
            className="pdf-layer"
            style={{
              width: layerW,
              height: layerH,
              left: (size.width - layerW) / 2,
              top: (size.height - layerH) / 2,
              transform: viewRotation ? `rotate(${viewRotation}deg)` : undefined,
            }}
          >
            {overlay({ pageNumber: info.pageNumber, info, scale, viewRotation, toNorm, getCanvas })}
          </div>
        )}
      </div>
    </div>
  );
}
