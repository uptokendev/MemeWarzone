import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ChevronLeft, ChevronRight, X } from "lucide-react";

/**
 * Image attached to a post (founder, 2026-10-03): shown whole (no cropping), rounded corners; tap
 * opens a full-screen viewer. Close with X, a click outside the image, Escape, or on phones the back
 * arrow top-left or a swipe down.
 */
export function PostImage({ src, className = "mt-3", alt = "" }: { src: string; className?: string; alt?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen(true);
        }}
        aria-label="Open image"
        className={`mw-focus block w-full overflow-hidden rounded-[14px] border border-mw-border bg-mw-input ${className}`}
        data-post-image="true"
      >
        <img src={src} alt={alt} loading="lazy" className="block max-h-[520px] w-full object-contain" />
      </button>
      {open ? <ImageViewer src={src} alt={alt} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function ImageViewer({ src, alt, onClose, images, start = 0 }: { src: string; alt: string; onClose: () => void; images?: string[]; start?: number }) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const startY = useRef<number | null>(null);
  const startX = useRef<number | null>(null);
  const [dragY, setDragY] = useState(0);
  // Several images (founder, 2026-10-04): left and right arrows, arrow keys or a sideways swipe.
  const list = images && images.length ? images : [src];
  const [index, setIndex] = useState(Math.min(Math.max(start, 0), list.length - 1));
  const many = list.length > 1;
  const go = (step: number) => setIndex((i) => (i + step + list.length) % list.length);
  const current = list[index] || src;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowRight" && list.length > 1) setIndex((i) => (i + 1) % list.length);
      if (event.key === "ArrowLeft" && list.length > 1) setIndex((i) => (i - 1 + list.length) % list.length);
    };
    window.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Image"
      className="fixed inset-0 z-[95] flex items-center justify-center bg-[rgba(5,6,8,0.92)] p-3 font-mw-body md:p-8"
      style={{ opacity: dragY > 0 ? Math.max(0.35, 1 - dragY / 400) : 1 }}
      onClick={onClose}
      onTouchStart={(event) => {
        startY.current = event.touches[0]?.clientY ?? null;
        startX.current = event.touches[0]?.clientX ?? null;
      }}
      onTouchMove={(event) => {
        if (startY.current == null) return;
        const dy = (event.touches[0]?.clientY ?? startY.current) - startY.current;
        setDragY(Math.max(0, dy));
      }}
      onTouchEnd={(event) => {
        const dx = startX.current == null ? 0 : (event.changedTouches[0]?.clientX ?? startX.current) - startX.current;
        if (dragY > 110) onClose();
        else if (many && Math.abs(dx) > 60 && dragY < 40) go(dx < 0 ? 1 : -1);
        setDragY(0);
        startY.current = null;
        startX.current = null;
      }}
    >
      {/* Phones: back arrow top-left. Desktop: X top-right. Both close. */}
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        aria-label="Back"
        className="mw-focus absolute left-3 top-3 inline-flex h-11 w-11 items-center justify-center rounded-full bg-[rgba(23,27,32,0.85)] text-mw-text md:hidden"
      >
        <ArrowLeft className="h-5 w-5" aria-hidden="true" />
      </button>
      <button
        ref={closeRef}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        aria-label="Close image"
        className="mw-focus absolute right-3 top-3 hidden h-11 w-11 items-center justify-center rounded-full bg-[rgba(23,27,32,0.85)] text-mw-text hover:bg-mw-raised md:inline-flex"
      >
        <X className="h-5 w-5" aria-hidden="true" />
      </button>
      {many ? (
        <>
          <button type="button" aria-label="Previous image" onClick={(event) => { event.stopPropagation(); go(-1); }} className="mw-focus absolute left-3 top-1/2 z-[1] hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-[rgba(23,27,32,0.85)] text-mw-text hover:bg-mw-raised md:inline-flex">
            <ChevronLeft className="h-6 w-6" aria-hidden="true" />
          </button>
          <button type="button" aria-label="Next image" onClick={(event) => { event.stopPropagation(); go(1); }} className="mw-focus absolute right-3 top-1/2 z-[1] hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-[rgba(23,27,32,0.85)] text-mw-text hover:bg-mw-raised md:inline-flex">
            <ChevronRight className="h-6 w-6" aria-hidden="true" />
          </button>
          <span className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-[rgba(23,27,32,0.85)] px-3 py-1 font-mw-mono text-sm text-mw-text">{index + 1} / {list.length}</span>
        </>
      ) : null}
      <img
        src={current}
        alt={alt}
        onClick={(event) => event.stopPropagation()}
        className="max-h-full max-w-full rounded-[14px] object-contain"
        style={{ transform: dragY ? `translateY(${dragY}px)` : undefined, transition: dragY ? "none" : "transform 0.15s ease" }}
        draggable={false}
      />
    </div>,
    document.body,
  );
}

/**
 * Up to 4 images on a post (founder, 2026-10-04), laid out like X: 1 full width, 2 side by side, 3 as one
 * tall plus two, 4 as a 2 x 2 grid. Tapping one opens the viewer on that image.
 */
export function PostImageGrid({ images, className = "mt-3" }: { images: string[]; className?: string }) {
  const list = images.filter(Boolean).slice(0, 4);
  const [open, setOpen] = useState<number | null>(null);
  if (!list.length) return null;
  if (list.length === 1) return <PostImage src={list[0]} className={className} />;
  const cell = (i: number, extra = "") => (
    <button
      key={`${i}:${list[i]}`}
      type="button"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setOpen(i);
      }}
      aria-label={`Open image ${i + 1} of ${list.length}`}
      className={`mw-focus block h-full w-full overflow-hidden bg-mw-input ${extra}`}
    >
      <img src={list[i]} alt="" loading="lazy" className="block h-full w-full object-cover" />
    </button>
  );
  return (
    <>
      <div className={`mw-image-grid grid h-[280px] gap-0.5 overflow-hidden rounded-[14px] border border-mw-border sm:h-[340px] ${list.length === 2 ? "grid-cols-2" : "grid-cols-2 grid-rows-2"} ${className}`} data-post-image-grid={list.length}>
        {list.length === 3 ? (
          <>
            {cell(0, "row-span-2")}
            {cell(1)}
            {cell(2)}
          </>
        ) : (
          list.map((_, i) => cell(i))
        )}
      </div>
      {open != null ? <ImageViewer src={list[open]} alt="" images={list} start={open} onClose={() => setOpen(null)} /> : null}
    </>
  );
}
