import type { SVGProps } from "react";

export function SparkleIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      focusable="false"
      {...props}
    >
      <path d="M12 2.5 9.6 9.6 2.5 12l7.1 2.4L12 21.5l2.4-7.1L21.5 12l-7.1-2.4L12 2.5zM5 5l-1 2.5L1.5 9 4 10l1 2.5L6.4 10 9 9l-2.6-1L5 5zm14 0-1 2.5L16.5 9 19 10l1 2.5L20.4 10 23 9l-2.6-1L19 5z" />
    </svg>
  );
}
