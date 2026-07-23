import type { SVGProps } from "react";

// Inline copies of the iconoir glyphs used on eagerly-loaded marketing pages.
// Importing them from iconoir-react would pull the whole vendor-ui chunk into
// the landing first-load; these keep the marketing routes dependency-free.
// Path data matches iconoir-react@7.11.0 regular icons exactly.

function MarketingIcon({
  paths,
  ...props
}: SVGProps<SVGSVGElement> & { paths: string[] }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      strokeWidth={1.5}
      color="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      {paths.map((d) => (
        <path key={d} d={d} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
      ))}
    </svg>
  );
}

export function MenuIcon(props: SVGProps<SVGSVGElement>) {
  return <MarketingIcon paths={["M3 5H21", "M3 12H21", "M3 19H21"]} {...props} />;
}

export function ComputerIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <MarketingIcon
      paths={[
        "M2 21L17 21",
        "M21 21L22 21",
        "M2 16.4V3.6C2 3.26863 2.26863 3 2.6 3H21.4C21.7314 3 22 3.26863 22 3.6V16.4C22 16.7314 21.7314 17 21.4 17H2.6C2.26863 17 2 16.7314 2 16.4Z",
      ]}
      {...props}
    />
  );
}

export function PlayIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <MarketingIcon
      paths={[
        "M6.90588 4.53682C6.50592 4.2998 6 4.58808 6 5.05299V18.947C6 19.4119 6.50592 19.7002 6.90588 19.4632L18.629 12.5162C19.0211 12.2838 19.0211 11.7162 18.629 11.4838L6.90588 4.53682Z",
      ]}
      {...props}
    />
  );
}

export function BellIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <MarketingIcon
      paths={[
        "M18 8.4C18 6.70261 17.3679 5.07475 16.2426 3.87452C15.1174 2.67428 13.5913 2 12 2C10.4087 2 8.88258 2.67428 7.75736 3.87452C6.63214 5.07475 6 6.70261 6 8.4C6 15.8667 3 18 3 18H21C21 18 18 15.8667 18 8.4Z",
        "M13.73 21C13.5542 21.3031 13.3019 21.5547 12.9982 21.7295C12.6946 21.9044 12.3504 21.9965 12 21.9965C11.6496 21.9965 11.3054 21.9044 11.0018 21.7295C10.6982 21.5547 10.4458 21.3031 10.27 21",
      ]}
      {...props}
    />
  );
}
