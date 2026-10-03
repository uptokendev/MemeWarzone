import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, X } from "lucide-react";

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

function ImageViewer({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const startY = useRef<number | null>(null);
  const [dragY, setDragY] = useState(0);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
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
      }}
      onTouchMove={(event) => {
        if (startY.current == null) return;
        const dy = (event.touches[0]?.clientY ?? startY.current) - startY.current;
        setDragY(Math.max(0, dy));
      }}
      onTouchEnd={() => {
        if (dragY > 110) onClose();
        else setDragY(0);
        startY.current = null;
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
      <img
        src={src}
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
