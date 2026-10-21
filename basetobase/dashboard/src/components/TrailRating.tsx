import type { ReactNode } from "react";
import type { Rating } from "../../../shared/src/config.ts";
import { RATING_LABELS } from "../../../shared/src/labels.ts";

const DIAMOND = "M7 0.5 L13.5 7 L7 13.5 L0.5 7 Z";
const SECOND_DIAMOND = "M19 0.5 L25.5 7 L19 13.5 L12.5 7 Z";
const VIEWBOX_HEIGHT = 14;

// The fill comes from the rating's class in theme.css.
const SHAPES: Record<Rating, { width: number; marks: ReactNode }> = {
  green: { width: 14, marks: <circle cx="7" cy="7" r="6" /> },
  blue: { width: 14, marks: <rect x="1" y="1" width="12" height="12" /> },
  black: { width: 14, marks: <path d={DIAMOND} /> },
  double_black: {
    width: 26,
    marks: (
      <>
        <path d={DIAMOND} />
        <path d={SECOND_DIAMOND} />
      </>
    ),
  },
};

// `size` is the icon's height in px.
export function TrailRating({ rating, size = 13 }: { rating: Rating; size?: number }) {
  const { width, marks } = SHAPES[rating];
  return (
    <svg
      className={`rating rating-${rating}`}
      width={(size * width) / VIEWBOX_HEIGHT}
      height={size}
      viewBox={`0 0 ${width} ${VIEWBOX_HEIGHT}`}
      role="img"
      aria-label={RATING_LABELS[rating]}
    >
      {marks}
    </svg>
  );
}
