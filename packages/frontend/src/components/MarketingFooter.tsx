import { TextLink } from "./TextLink";
import { Text } from "./Text";

export function MarketingFooter(props: { productName?: string }) {
  const productName = props.productName ?? "Instafy";

  return (
    <footer className="w-full pt-16 pb-10 text-center">
      <div className="mx-auto w-full max-w-6xl px-6">
        <div className="flex flex-col items-center gap-3">
          <div className="flex items-center justify-center gap-3 text-xs text-slate-500 dark:text-slate-400">
            <TextLink to="/terms" size="xs" tone="muted">
              Terms of Use
            </TextLink>
            <span className="text-slate-300 dark:text-slate-600">|</span>
            <TextLink to="/privacy" size="xs" tone="muted">
              Privacy Policy
            </TextLink>
          </div>
          <Text variant="caption">© {new Date().getFullYear()} {productName}. Crafted with care.</Text>
        </div>
      </div>
    </footer>
  );
}

