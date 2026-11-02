import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Badge } from "../../../components/Badge";
import { SegmentedControl } from "../../../components/SegmentedControl";
import { Button } from "../../../components/Button";
import { Card } from "../../../components/Card";
import { Heading } from "../../../components/Heading";
import { LoadingStatus } from "../../../components/LoadingStatus";
import { Text } from "../../../components/Text";
import { BILLING_PLANS, type BillingPlanDefinition } from "../../../credits/plans";
import { fetchCreditPolicy, type CreditPolicy } from "../../../credits/creditService";
import { ledgerActivityRows } from "../../../credits/ledgerActivityRows";
import {
  requestBillingPortalSession,
  requestCheckoutSession,
  requestPlanChange,
} from "../../../credits/checkoutService";
import {
  LIVE_ACCESS_PLURAL,
  LIVE_ACCESS_SINGULAR,
  LIVE_CONNECTIONS_PLURAL,
} from "../../../credits/usageLabels";
import { CREDITS_UPDATED_EVENT, useCredits } from "../../../credits/useCredits";
import { isPersonalOrgName } from "../../../org/orgNaming";
import { useProjects } from "../../../projects/useProjects";
import { useStatus } from "../../../status/useStatus";
import { CreditActivityChart, type CreditActivityRange } from "./CreditActivityChart";
import {
  CreditsUsageRates,
  formatCreditsPerMinute,
  formatIntervalSeconds,
  formatUnits,
} from "./CreditsUsageRates";
import { SettingsShell, type SettingsCategory } from "./SettingsShell";

const CHECKOUT_STATUS_PARAM = "billingCheckout";
const CHECKOUT_PLAN_PARAM = "billingPlan";
// The Activity log opens on the newest rows; "Show more" reveals the rest of
// what the panel loaded, a page at a time.
const ACTIVITY_FIRST_ROWS = 8;
const ACTIVITY_MORE_ROWS = 20;

function formatMonthlyPrice(cents: number, currency: string): string {
  if (!Number.isFinite(cents) || cents <= 0) {
    return "Free";
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency || "USD",
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2
  }).format(cents / 100);
}

function formatUsdAmount(value: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency || "USD",
    minimumFractionDigits: value >= 10 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value);
}

/** `unitLabel` for an amount of `value`: "1 credit", "2 credits". */
function unitFor(value: number, unitLabel: string): string {
  return Math.abs(value) === 1 ? unitLabel.replace(/s$/, "") : unitLabel;
}

function formatEstimateSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "—";
  }
  if (seconds === 0) {
    return "0m";
  }
  return formatIntervalSeconds(seconds);
}

export function CreditsPanel() {
  const {
    billing,
    controllerEnabled,
    hasLoaded: creditsLoaded,
    lastError: creditsError,
    ledger,
    ledgerError,
    refresh: refreshCredits,
  } = useCredits();
  const { activeProjectId, projectList } = useProjects();
  // A space of the person's own: no team shares its balance, so the panel
  // never says "team" or "shared" there (the same rule as "Personal settings").
  const personal = isPersonalOrgName(projectList.find((project) => project.id === activeProjectId)?.orgName);
  const { showStatus } = useStatus();
  const location = useLocation();
  const navigate = useNavigate();
  const [selectedPlanId, setSelectedPlanId] = useState<string>(BILLING_PLANS[0]?.id ?? "starter");
  const [checkoutPending, setCheckoutPending] = useState(false);
  const [portalPending, setPortalPending] = useState(false);
  const [planChangePending, setPlanChangePending] = useState(false);
  const [armedPlanChangeId, setArmedPlanChangeId] = useState<string | null>(null);
  // Set after a paid checkout/plan change while we wait for the Stripe webhook
  // to grant the new entitlements. planId is the plan we expect to land on.
  const [activation, setActivation] = useState<{ planId: string | null } | null>(null);
  const [policy, setPolicy] = useState<CreditPolicy | null>(null);
  const [policyLoading, setPolicyLoading] = useState(false);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [section, setSection] = useState<"activity" | "plans" | "usage">("activity");
  const [activityView, setActivityView] = useState<"log" | "graph">("log");
  const [graphRange, setGraphRange] = useState<CreditActivityRange>("7d");
  const [amountView, setAmountView] = useState<"units" | "usd">("units");
  const [activityRowCount, setActivityRowCount] = useState(ACTIVITY_FIRST_ROWS);
  // "Show more" moves focus to the first row it revealed, as Details' "Show
  // earlier steps" does, since the button itself may go away.
  const [activityFocusRow, setActivityFocusRow] = useState<number | null>(null);
  const activityFocusRowRef = useRef<HTMLDivElement | null>(null);
  const policyInFlightRef = useRef(false);
  const lastPolicyProjectRef = useRef<string | null>(null);
  const didInitSelectionRef = useRef(false);
  const checkoutReturnHandledRef = useRef(false);
  const activationDeadlineRef = useRef(0);

  const categories = useMemo<SettingsCategory[]>(
    () => [
      {
        id: "activity",
        label: "Activity",
        testId: "settings-category-credits-activity",
      },
      {
        id: "plans",
        label: "Plans",
        testId: "settings-category-credits-plans",
      },
      {
        id: "usage",
        label: "Usage",
        testId: "settings-category-credits-usage",
      },
    ],
    [],
  );

  const handleSectionChange = useCallback((next: string) => {
    if (next === "activity" || next === "plans" || next === "usage") {
      setSection(next);
    }
  }, []);

  const creditBalance = billing.creditBalance ?? 0;
  const creditLimit = billing.creditLimit ?? 0;
  const subscription = billing.subscription;
  const subscriptionStatus =
    typeof subscription?.status === "string" ? subscription.status.toLowerCase() : null;
  const subscriptionProcessor =
    typeof subscription?.processor === "string" ? subscription.processor.toLowerCase() : null;
  const hasPaidPlan =
    subscriptionProcessor === "stripe" &&
    Boolean(subscriptionStatus) &&
    !["none", "canceled"].includes(subscriptionStatus ?? "");
  // past_due keeps the paid plan's limits while Stripe dunning retries the
  // card (backend grace period) — surface it loudly instead of hiding it.
  const isPastDue = subscriptionProcessor === "stripe" && subscriptionStatus === "past_due";
  const subscriptionCancelAtPeriodEnd = subscription?.cancelAtPeriodEnd === true;
  const subscriptionPeriodEnd =
    typeof subscription?.currentPeriodEnd === "string" ? subscription.currentPeriodEnd : null;
  // A canceled or otherwise non-active subscription drops the team back to the free
  // Starter tier, so treat it as Starter for all plan-display logic below (current
  // badge, subtitle, default selection). Prevents a canceled team from still showing
  // "Pro" and a free team from showing a "Continue with Starter" CTA.
  const rawSubscriptionPlanId =
    typeof subscription?.planId === "string" ? subscription.planId.toLowerCase() : null;
  const subscriptionPlanId = hasPaidPlan ? rawSubscriptionPlanId : "starter";
  const lowBalanceThreshold = Math.max(2, Math.floor(creditLimit * 0.2));
  const lowBalance = creditLimit > 0 && creditBalance <= lowBalanceThreshold;

  const hostedRuntimeProviderRates = useMemo(() => {
    const providers = policy?.usage?.hostedRuntimeProviders;
    return Array.isArray(providers) ? providers : [];
  }, [policy]);
  const managedAiUsage = policy?.usage?.managedAi ?? null;
  const unitLabel = policy?.display?.unitLabel?.trim() || "credits";
  const displayCurrency = policy?.display?.currency?.trim() || "USD";
  const unitsPerUsd = policy?.display?.unitsPerUsd && policy.display.unitsPerUsd > 0 ? policy.display.unitsPerUsd : 1_000;
  const balanceUsd = creditBalance / unitsPerUsd;
  const limitUsd = creditLimit / unitsPerUsd;

  const usageRateRows = useMemo(() => {
    if (!policy?.usage) {
      return [];
    }
    const rows: Array<{
      key: string;
      label: string;
      rate: { enabled: boolean; creditsPerMinute: number; intervalSeconds: number };
    }> = [{ key: "tunnels", label: LIVE_ACCESS_PLURAL, rate: policy.usage.tunnel }];

    if (hostedRuntimeProviderRates.length > 0) {
      rows.push(
        ...hostedRuntimeProviderRates.map((provider) => ({
          key: `hosted-${provider.providerId}`,
          label: `Hosted runtime (${provider.displayName})`,
          rate: provider,
        })),
      );
    } else {
      rows.push({
        key: "hosted-runtimes",
        label: "Hosted runtimes",
        rate: policy.usage.hostedRuntime,
      });
    }

    return rows;
  }, [hostedRuntimeProviderRates, policy]);

  const hostedRuntimeEstimate = useMemo(() => {
    const enabledProviders = hostedRuntimeProviderRates.filter(
      (provider) => provider.enabled && provider.creditsPerMinute > 0,
    );
    if (enabledProviders.length === 0) {
      return { enabled: false as const, range: null as null | [number, number], creditsPerMinute: 0 };
    }
    const values = enabledProviders.map((provider) => provider.creditsPerMinute);
    const min = Math.min(...values);
    const max = Math.max(...values);
    return {
      enabled: true as const,
      range: min === max ? null : ([min, max] as [number, number]),
      creditsPerMinute: min,
    };
  }, [hostedRuntimeProviderRates]);

  const refreshPolicy = useCallback(
    async (options?: { force?: boolean; notifyOnError?: boolean }) => {
      if (!controllerEnabled || !activeProjectId) {
        policyInFlightRef.current = false;
        lastPolicyProjectRef.current = null;
        setPolicyLoading(false);
        setPolicy(null);
        setPolicyError(null);
        return;
      }
      if (policyInFlightRef.current) {
        return;
      }
      if (!options?.force && lastPolicyProjectRef.current === activeProjectId) {
        return;
      }
      const notifyOnError = options?.notifyOnError ?? false;
      policyInFlightRef.current = true;
      setPolicyLoading(true);
      setPolicyError(null);
      try {
        const result = await fetchCreditPolicy(activeProjectId);
        if (result.success && result.policy) {
          setPolicy(result.policy);
          lastPolicyProjectRef.current = activeProjectId;
        } else if (!result.success) {
          const message = result.error ?? "Unable to load credit policy.";
          setPolicy(null);
          setPolicyError(message);
          if (notifyOnError) {
            showStatus(message, "error", 4000);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setPolicy(null);
        setPolicyError(message);
        if (notifyOnError) {
          showStatus(message, "error", 4000);
        }
      } finally {
        policyInFlightRef.current = false;
        setPolicyLoading(false);
      }
    },
    [activeProjectId, controllerEnabled, showStatus],
  );

  useEffect(() => {
    lastPolicyProjectRef.current = null;
  }, [activeProjectId]);

  useEffect(() => {
    void refreshPolicy();
  }, [refreshPolicy]);

  const formatDelta = useCallback((delta: number) => {
    if (delta > 0) {
      return `+${delta}`;
    }
    return delta.toString();
  }, []);

  const formatLedgerReason = useCallback((reason: string) => {
    const normalized = reason.trim();
    if (!normalized) {
      return "Activity";
    }
    if (normalized === "hosted_runtime") {
      return "Hosted runtime";
    }
    if (normalized === "tunnel_grant") {
      return `${LIVE_ACCESS_SINGULAR} usage`;
    }
    if (normalized === "sandbox_seed") {
      return "Starting balance";
    }
    if (normalized === "auto_refill_daily") {
      // Says what the panel's refill line says: the balance tops back up.
      return "Daily top-up";
    }
    const humanized = normalized.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
    return humanized.charAt(0).toUpperCase() + humanized.slice(1);
  }, []);

  const formatDeltaValue = useCallback(
    (delta: number) => {
      if (amountView === "usd") {
        const usdValue = delta / unitsPerUsd;
        const sign = usdValue > 0 ? "+" : "";
        return `${sign}${formatUsdAmount(usdValue, displayCurrency)}`;
      }
      return `${formatDelta(delta)} ${unitFor(delta, unitLabel)}`;
    },
    [amountView, displayCurrency, formatDelta, unitLabel, unitsPerUsd],
  );

  // One row per Instafy AI turn, named by its chat; other entries as they are.
  const activityRows = useMemo(
    () => ledgerActivityRows(ledger, formatLedgerReason),
    [formatLedgerReason, ledger],
  );
  const recentActivity = activityRows.slice(0, activityRowCount);
  const hasMoreActivity = activityRows.length > recentActivity.length;
  const showMoreActivity = useCallback(() => {
    setActivityFocusRow(activityRowCount);
    setActivityRowCount((count) => count + ACTIVITY_MORE_ROWS);
  }, [activityRowCount]);

  useEffect(() => {
    if (activityFocusRow !== null) {
      activityFocusRowRef.current?.focus();
    }
  }, [activityFocusRow]);

  const planCatalog = useMemo<BillingPlanDefinition[]>(() => {
    const policyPlans = policy?.plans;
    if (!Array.isArray(policyPlans) || policyPlans.length === 0) {
      return BILLING_PLANS;
    }

    const marketingById = new Map<string, BillingPlanDefinition>();
    for (const plan of BILLING_PLANS) {
      marketingById.set(plan.id, plan);
    }

    const merged = policyPlans.map((plan) => {
      const marketing = marketingById.get(plan.id);
      const processor =
        marketing?.processor ?? (plan.monthlyPriceCents > 0 ? "stripe" : "dev");
      return {
        id: plan.id,
        name: plan.name,
        description: marketing?.description ?? "",
        creditLimit: plan.creditLimit,
        maxActiveTunnels: plan.maxActiveTunnels,
        maxActiveHostedRuntimes: plan.maxActiveHostedRuntimes,
        monthlyPriceCents: plan.monthlyPriceCents,
        currency: plan.currency,
        processor,
        highlight: marketing?.highlight,
      };
    });

    const order = BILLING_PLANS.map((plan) => plan.id);
    merged.sort((a, b) => {
      const aIdx = order.indexOf(a.id);
      const bIdx = order.indexOf(b.id);
      if (aIdx !== -1 || bIdx !== -1) {
        if (aIdx === -1) return 1;
        if (bIdx === -1) return -1;
        return aIdx - bIdx;
      }
      if (a.monthlyPriceCents !== b.monthlyPriceCents) {
        return a.monthlyPriceCents - b.monthlyPriceCents;
      }
      return a.id.localeCompare(b.id);
    });

    return merged;
  }, [policy]);

  const selectedPlan = useMemo(() => {
    return planCatalog.find((plan) => plan.id === selectedPlanId) ?? planCatalog[0];
  }, [planCatalog, selectedPlanId]);
  const selectedPlanIsCurrent =
    Boolean(selectedPlan?.id) && Boolean(subscriptionPlanId) && selectedPlan?.id === subscriptionPlanId;
  const currentPlan = useMemo(
    () => (subscriptionPlanId ? planCatalog.find((plan) => plan.id === subscriptionPlanId) ?? null : null),
    [planCatalog, subscriptionPlanId],
  );
  // While on a paid plan, paid→paid moves are an in-place subscription update
  // (a second checkout would double-bill); moving to the free plan means
  // canceling, which happens in the billing portal.
  const isPortalDowngrade =
    hasPaidPlan &&
    Boolean(selectedPlan) &&
    !selectedPlanIsCurrent &&
    (selectedPlan?.monthlyPriceCents ?? 0) <= 0;
  const isPaidPlanSwitch =
    hasPaidPlan &&
    Boolean(selectedPlan) &&
    !selectedPlanIsCurrent &&
    (selectedPlan?.monthlyPriceCents ?? 0) > 0;
  const isPaidPlanUpgrade =
    isPaidPlanSwitch &&
    (selectedPlan?.monthlyPriceCents ?? 0) > (currentPlan?.monthlyPriceCents ?? 0);
  const currentPlanLabel = useMemo(() => {
    if (subscriptionPlanId) {
      return (
        planCatalog.find((plan) => plan.id === subscriptionPlanId)?.name ??
        subscriptionPlanId.charAt(0).toUpperCase() + subscriptionPlanId.slice(1)
      );
    }
    return selectedPlan?.name ?? null;
  }, [planCatalog, selectedPlan, subscriptionPlanId]);
  const sectionLabel = useMemo(() => {
    if (section === "plans") {
      return currentPlanLabel ? `Plans · ${currentPlanLabel}` : "Plans";
    }
    if (section === "usage") return "Usage";
    return "Activity";
  }, [currentPlanLabel, section]);

  useEffect(() => {
    if (planCatalog.length === 0) {
      return;
    }
    if (planCatalog.some((plan) => plan.id === selectedPlanId)) {
      return;
    }
    setSelectedPlanId(planCatalog[0]?.id ?? "starter");
  }, [planCatalog, selectedPlanId]);

  // Default the selected plan to the team's current plan the first time we learn it.
  useEffect(() => {
    if (didInitSelectionRef.current) {
      return;
    }
    if (!subscriptionPlanId) {
      return;
    }
    if (planCatalog.some((plan) => plan.id === subscriptionPlanId)) {
      setSelectedPlanId(subscriptionPlanId);
      didInitSelectionRef.current = true;
    }
  }, [planCatalog, subscriptionPlanId]);

  // Re-derive the pre-selected plan when the user switches projects/orgs,
  // and drop any in-flight activation state — it belongs to the previous org.
  useEffect(() => {
    didInitSelectionRef.current = false;
    setActivation(null);
    setArmedPlanChangeId(null);
    setActivityRowCount(ACTIVITY_FIRST_ROWS);
    setActivityFocusRow(null);
  }, [activeProjectId]);

  // Two-step plan-change confirmation resets when the selection moves.
  useEffect(() => {
    setArmedPlanChangeId(null);
  }, [selectedPlanId]);

  // Handle the return from Stripe Checkout (success/cancel marker on the URL).
  useEffect(() => {
    if (checkoutReturnHandledRef.current) {
      return;
    }
    const params = new URLSearchParams(location.search);
    const status = params.get(CHECKOUT_STATUS_PARAM);
    if (status !== "success" && status !== "cancel") {
      return;
    }
    checkoutReturnHandledRef.current = true;
    const planId = params.get(CHECKOUT_PLAN_PARAM);

    // Strip the markers through the router so its history state stays
    // coherent and the toast cannot re-fire on back/forward navigation.
    params.delete(CHECKOUT_STATUS_PARAM);
    params.delete(CHECKOUT_PLAN_PARAM);
    const search = params.toString();
    navigate(
      { pathname: location.pathname, search: search ? `?${search}` : "", hash: location.hash },
      { replace: true },
    );

    if (status === "success") {
      // Payment is done, but entitlements arrive via the Stripe webhook —
      // show a pending state and poll instead of asserting the plan from URL
      // parameters that anyone could type in.
      setActivation({ planId });
    } else {
      showStatus("Checkout canceled — no changes were made to your plan.", "info", 5000, {
        forceVisible: true,
        id: "billing-checkout-cancel",
      });
    }
  }, [location.hash, location.pathname, location.search, navigate, showStatus]);

  // While a checkout/plan change is activating, poll until the webhook lands.
  // Ticks are skipped while the tab is hidden, and a credits.updated event
  // refreshes right away instead of waiting for the next tick.
  useEffect(() => {
    if (!activation) {
      return;
    }
    activationDeadlineRef.current = Date.now() + 60_000;
    void refreshCredits({ force: true, notifyOnError: false });
    void refreshPolicy({ force: true });
    const intervalId = window.setInterval(() => {
      if (Date.now() > activationDeadlineRef.current) {
        setActivation(null);
        showStatus(
          "Payment received — your plan is still activating. This page will update automatically in a moment.",
          "info",
          8000,
          { forceVisible: true, id: "billing-activation-slow" },
        );
        return;
      }
      if (document.visibilityState === "hidden") {
        return;
      }
      void refreshCredits({ force: true, notifyOnError: false });
    }, 2_500);
    const handleCreditsUpdated = () => {
      void refreshCredits({ force: true, notifyOnError: false });
      void refreshPolicy({ force: true });
    };
    window.addEventListener(CREDITS_UPDATED_EVENT, handleCreditsUpdated);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener(CREDITS_UPDATED_EVENT, handleCreditsUpdated);
    };
  }, [activation, refreshCredits, refreshPolicy, showStatus]);

  // Activation completes when the snapshot reflects the expected plan.
  useEffect(() => {
    if (!activation) {
      return;
    }
    const target = activation.planId;
    const landed = target ? hasPaidPlan && subscriptionPlanId === target : hasPaidPlan;
    if (!landed) {
      return;
    }
    const plan = planCatalog.find((entry) => entry.id === (target ?? subscriptionPlanId)) ?? null;
    const message = plan
      ? `You're on ${plan.name}! ${plan.creditLimit} credits/day · ${plan.maxActiveTunnels} ${LIVE_CONNECTIONS_PLURAL} · ${plan.maxActiveHostedRuntimes} hosted runtimes.`
      : "You're all set — your new plan is active.";
    showStatus(message, "success", 8000, { forceVisible: true, id: "billing-checkout-success" });
    setActivation(null);
  }, [activation, hasPaidPlan, planCatalog, showStatus, subscriptionPlanId]);

  const handleCheckout = useCallback(async () => {
    if (!controllerEnabled) {
      showStatus("Connect the runtime controller before starting checkout.", "error", 4000);
      return;
    }
    if (!activeProjectId) {
      showStatus("Select or create a space before upgrading.", "error", 4000);
      return;
    }
    if (!selectedPlan) {
      showStatus("Select a plan before continuing.", "error", 3500);
      return;
    }
    if (selectedPlanIsCurrent) {
      showStatus("You are already on this plan.", "info", 2500);
      return;
    }

    const buildReturnUrl = (extraParams: Record<string, string>): string => {
      if (typeof window === "undefined") {
        return "https://instafy.dev";
      }
      const url = new URL(window.location.href);
      for (const [key, value] of Object.entries(extraParams)) {
        url.searchParams.set(key, value);
      }
      return url.toString();
    };
    const successUrl = buildReturnUrl({
      [CHECKOUT_STATUS_PARAM]: "success",
      [CHECKOUT_PLAN_PARAM]: selectedPlan.id,
    });
    const cancelUrl = buildReturnUrl({ [CHECKOUT_STATUS_PARAM]: "cancel" });
    setCheckoutPending(true);
    try {
      const result = await requestCheckoutSession({
        projectId: activeProjectId,
        planId: selectedPlan.id,
        processor: selectedPlan.processor,
        successUrl,
        cancelUrl
      });
      if (!result.success || !result.checkoutUrl) {
        showStatus(result.error ?? "Unable to start checkout.", "error", 4500);
        return;
      }
      showStatus("Redirecting to checkout…", "success", 2000);
      if (typeof window !== "undefined") {
        window.location.assign(result.checkoutUrl);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showStatus(`Unable to start checkout: ${message}`, "error", 4500);
    } finally {
      setCheckoutPending(false);
    }
  }, [activeProjectId, controllerEnabled, selectedPlan, selectedPlanIsCurrent, showStatus]);

  const handlePlanChange = useCallback(async () => {
    if (!controllerEnabled) {
      showStatus("Connect the runtime controller before changing plans.", "error", 4000);
      return;
    }
    if (!activeProjectId) {
      showStatus("Select or create a space before changing plans.", "error", 4000);
      return;
    }
    if (!selectedPlan) {
      showStatus("Select a plan before continuing.", "error", 3500);
      return;
    }
    // First press arms the confirmation (upgrades charge the prorated
    // difference immediately); the second press executes.
    if (armedPlanChangeId !== selectedPlan.id) {
      setArmedPlanChangeId(selectedPlan.id);
      return;
    }
    setArmedPlanChangeId(null);
    setPlanChangePending(true);
    try {
      const result = await requestPlanChange({
        projectId: activeProjectId,
        planId: selectedPlan.id,
      });
      if (!result.success) {
        showStatus(result.error ?? "Unable to change plan.", "error", 5000);
        return;
      }
      showStatus(`Switching to ${selectedPlan.name}…`, "success", 3000);
      setActivation({ planId: selectedPlan.id });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showStatus(`Unable to change plan: ${message}`, "error", 5000);
    } finally {
      setPlanChangePending(false);
    }
  }, [activeProjectId, armedPlanChangeId, controllerEnabled, selectedPlan, showStatus]);

  const handleManageSubscription = useCallback(async () => {
    if (!controllerEnabled) {
      showStatus("Connect the runtime controller before opening the billing portal.", "error", 4000);
      return;
    }
    if (!activeProjectId) {
      showStatus("Select or create a space before managing billing.", "error", 4000);
      return;
    }
    const destination = typeof window !== "undefined" ? window.location.href : "https://instafy.dev";
    const portalWindow =
      typeof window !== "undefined" ? window.open("about:blank", "_blank") : null;
    try {
      if (portalWindow) {
        portalWindow.opener = null;
      }
    } catch {
      // ignore popup hardening failures
    }
    setPortalPending(true);
    try {
      const result = await requestBillingPortalSession({ projectId: activeProjectId, returnUrl: destination });
      if (!result.success || !result.url) {
        portalWindow?.close?.();
        showStatus(result.error ?? "Unable to open billing portal.", "error", 4500);
        return;
      }
      showStatus("Opening billing portal…", "success", 2000);
      if (typeof window !== "undefined") {
        if (portalWindow && !portalWindow.closed) {
          portalWindow.location.assign(result.url);
        } else {
          window.location.assign(result.url);
        }
      }
    } catch (error) {
      portalWindow?.close?.();
      const message = error instanceof Error ? error.message : String(error);
      showStatus(`Unable to open billing portal: ${message}`, "error", 4500);
    } finally {
      setPortalPending(false);
    }
  }, [activeProjectId, controllerEnabled, showStatus]);

  const balanceDisplayValue =
    amountView === "usd" ? formatUsdAmount(balanceUsd, displayCurrency) : String(creditBalance);
  const limitDisplayValue =
    amountView === "usd" ? formatUsdAmount(limitUsd, displayCurrency) : String(creditLimit);

  // Fuel gauge: what a hosted machine costs and how long the current balance
  // lasts — pre-answers "why did my runtime pause" before it happens.
  const runtimeRunwayDisplay = useMemo(() => {
    const hostedRates = [
      ...(policy?.usage?.hostedRuntimeProviders ?? []),
      ...(policy?.usage?.hostedRuntime ? [policy.usage.hostedRuntime] : []),
    ].filter((rate) => rate.enabled && rate.creditsPerMinute > 0);
    if (hostedRates.length === 0) {
      return null;
    }
    const creditsPerMinute = Math.max(...hostedRates.map((rate) => rate.creditsPerMinute));
    const perHour = creditsPerMinute * 60;
    const perHourLabel = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(
      perHour,
    );
    if (creditBalance <= 0) {
      return `Hosted machine costs ≈${perHourLabel} ${unitLabel}/hour — balance is empty until the daily top-up.`;
    }
    const minutesLeft = creditBalance / creditsPerMinute;
    const runway =
      minutesLeft >= 90
        ? `${(minutesLeft / 60).toFixed(minutesLeft >= 600 ? 0 : 1)} h`
        : `${Math.max(1, Math.round(minutesLeft))} min`;
    return `Hosted machine costs ≈${perHourLabel} ${unitLabel}/hour — current balance runs one for ~${runway}.`;
  }, [creditBalance, policy, unitLabel]);

  const renewalDisplay = useMemo(() => {
    if (!hasPaidPlan || !subscriptionPeriodEnd) {
      return null;
    }
    const date = new Date(subscriptionPeriodEnd);
    if (Number.isNaN(date.getTime())) {
      return null;
    }
    const formatted = date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    if (subscriptionCancelAtPeriodEnd) {
      return `Cancels on ${formatted} — ${currentPlanLabel ?? "your plan"} stays active until then`;
    }
    return `Renews ${formatted}`;
  }, [currentPlanLabel, hasPaidPlan, subscriptionCancelAtPeriodEnd, subscriptionPeriodEnd]);

  return (
    <SettingsShell
      title={personal ? "Credits" : "Team credits"}
      subtitle={sectionLabel}
      navLabel="Sections"
      categories={categories}
      activeCategoryId={section}
      onCategoryChange={handleSectionChange}
    >
      <Card
        tone={lowBalance ? "warning" : "default"}
        radius="2xl"
        shadow="sm"
        padding="md"
        className="space-y-4"
      >
        <div className="space-y-2">
          <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
            <div className="min-w-0">
              <Text variant="bodyStrong" tone="secondary" data-testid="credits-balance-label">
                {personal ? "Balance" : "Shared team balance"}
              </Text>
              {!creditsLoaded && !creditsError ? (
                <LoadingStatus
                  className="mt-2"
                  data-testid="credits-balance-loading"
                >
                  Loading balance…
                </LoadingStatus>
              ) : !creditsLoaded && creditsError ? (
                <div className="mt-2 space-y-2" data-testid="credits-balance-error">
                  <Text as="p" variant="body" tone="danger" className="font-medium">
                    Couldn't load your balance.
                  </Text>
                  <Button
                    onPress={() => void refreshCredits({ force: true, notifyOnError: true })}
                    variant="outline"
                    size="xs"
                    radius="full"
                  >
                    Retry
                  </Button>
                </div>
              ) : (
                // The balance is a number of credits, never a fraction of the
                // limit: paid credits can take it past the daily refill.
                <Text as="div" variant="display" tone="primary" data-testid="credits-balance-row" className="mt-1">
                  <span data-testid="credits-balance">{balanceDisplayValue}</span>
                  {amountView === "usd" ? null : (
                    <Text as="span" variant="subtitle" tone="muted" className="ml-2">
                      {unitFor(creditBalance, unitLabel)}
                    </Text>
                  )}
                </Text>
              )}
            </div>
            <div className="flex items-start gap-2 md:flex-col md:items-end">
              <SegmentedControl aria-label="Credit display units" value={amountView} onChange={setAmountView} width="fit"
                options={[
                  { value: "units", label: unitLabel, testId: "credits-amount-view-units" },
                  { value: "usd", label: displayCurrency, testId: "credits-amount-view-usd" },
                ]} />
              {hasPaidPlan ? (
                <Button
                  onPress={handleManageSubscription}
                  isDisabled={!controllerEnabled || portalPending}
                  variant="outline"
                  size="xs"
                  radius="full"
                  data-testid="billing-manage-subscription"
                >
                  {portalPending ? "Opening portal…" : "Manage subscription"}
                </Button>
              ) : null}
            </div>
          </div>
          {/* Once a UTC day, the first time the controller finds the balance
              under the team's own limit, it tops it back up to that limit (the
              ledger's "Daily top-up" row adds the difference; credits.rs
              attempt_daily_refill). That can be at any hour, so the line names
              the level and how often, never an hour or an amount added. */}
          {creditsLoaded && creditLimit > 0 ? (
            <Text as="div" variant="caption" tone="muted" data-testid="credits-starter-budget">
              Tops back up to <span data-testid="credits-limit">{limitDisplayValue}</span>
              {amountView === "usd" ? "" : ` ${unitFor(creditLimit, unitLabel)}`} once a day
            </Text>
          ) : null}
          {runtimeRunwayDisplay ? (
            <Text as="div" variant="caption" tone="muted" data-testid="credits-runtime-runway">
              {runtimeRunwayDisplay}
            </Text>
          ) : null}
          {renewalDisplay ? (
            <Text as="div" variant="caption" tone="muted" data-testid="billing-renewal-date">
              {renewalDisplay}
            </Text>
          ) : null}
        </div>
      </Card>

      {isPastDue ? (
        <Card
          tone="warning"
          radius="2xl"
          shadow="sm"
          padding="md"
          className="space-y-2"
          data-testid="billing-past-due-banner"
        >
          <Text as="p" variant="bodyStrong" tone="primary">
            Your last payment failed
          </Text>
          <Text as="p" variant="body" tone="secondary">
            We couldn't charge your card for {currentPlanLabel ?? "your plan"}. Stripe retries
            automatically — update your payment method to keep your plan. If payment keeps
            failing, {personal ? "you go" : "your team drops"} back to the free Starter tier.
          </Text>
          <Button
            onPress={handleManageSubscription}
            isDisabled={!controllerEnabled || portalPending}
            variant="primary"
            size="xs"
            radius="full"
            data-testid="billing-past-due-update-payment"
          >
            {portalPending ? "Opening portal…" : "Update payment method"}
          </Button>
        </Card>
      ) : null}

      {activation ? (
        <Card
          radius="2xl"
          shadow="sm"
          padding="md"
          className="flex items-center gap-3"
          data-testid="billing-activation-pending"
        >
          <LoadingStatus>
            Payment received — activating your new plan…
          </LoadingStatus>
        </Card>
      ) : null}

      {section === "usage" ? (
        <Card radius="2xl" shadow="sm" padding="md" className="space-y-3">
          <div className="space-y-1">
            <Heading level={3} variant="subtitle">
              Usage rates
            </Heading>
            <Text variant="body" tone="secondary">
              AI prompts, live access, and hosted runtimes all burn from the same {personal ? "" : "team "}balance.
            </Text>
          </div>
          {policyLoading ? (
            <LoadingStatus>Loading usage rates…</LoadingStatus>
          ) : policyError ? (
            <Text variant="body" tone="danger" className="font-medium">
              {policyError}
            </Text>
          ) : policy?.usage ? (
            <div className="space-y-2">
              <CreditsUsageRates
                personal={personal}
                usageRateRows={usageRateRows}
                managedAiUsage={managedAiUsage}
                unitLabel={unitLabel}
                displayCurrency={displayCurrency}
              />
              <Text variant="caption" tone="muted">
                {hostedRuntimeEstimate.enabled
                  ? `At ${formatCreditsPerMinute(hostedRuntimeEstimate.creditsPerMinute)} credits/min per hosted runtime` +
                    (hostedRuntimeEstimate.range
                      ? ` (varies by type: ${formatCreditsPerMinute(hostedRuntimeEstimate.range[0])}–${formatCreditsPerMinute(
                          hostedRuntimeEstimate.range[1],
                        )}), `
                      : ", ") +
                    `your current balance covers ~${formatEstimateSeconds(
                      (creditBalance / hostedRuntimeEstimate.creditsPerMinute) * 60,
                    )} for one active hosted runtime.`
                  : `Hosted runtime metering is currently disabled (0 credits/min). ` +
                    `If you plan for 1 credit/min, your current balance covers ~${formatEstimateSeconds(
                      creditBalance * 60,
                    )} for one hosted runtime.`}
              </Text>
            </div>
          ) : (
            <div className="space-y-2">
              <Text variant="body" tone="secondary">
                {policyError ? "Couldn't load usage rates." : "Usage rates are not available."}
              </Text>
              <Button
                onPress={() => void refreshPolicy({ force: true, notifyOnError: true })}
                isDisabled={policyLoading}
                variant="outline"
                size="xs"
                radius="full"
              >
                {policyLoading ? "Retrying…" : "Retry"}
              </Button>
            </div>
          )}
        </Card>
      ) : null}

      {section === "plans" ? (
        <div className="space-y-3">
          <div className="space-y-1">
            <Heading level={3} variant="subtitle">
              Plans
            </Heading>
            <Text variant="body" tone="secondary">
              {personal
                ? "Your balance tops back up daily (UTC) to the selected plan limit. Limits shown below are defaults; overrides may apply."
                : "Your shared balance tops back up daily (UTC) to the selected plan limit. Limits shown below are defaults; team-specific overrides may apply."}
            </Text>
            <Text variant="caption" tone="muted" data-testid="billing-hosted-runtime-definition">
              "Hosted runtimes" are cloud machines (2 CPU · 4 GB · Node, Python, browsers) that run
              from this credit balance while active and pause when idle. Your own machine, connected
              via the desktop agent, is always free and unlimited.
            </Text>
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            {planCatalog.map((plan) => {
              const isSelected = plan.id === selectedPlan?.id;
              const isCurrent = plan.id === subscriptionPlanId;
              const priceLabel = formatMonthlyPrice(plan.monthlyPriceCents, plan.currency);
              return (
                <Button
                  key={plan.id}
                  onPress={() => setSelectedPlanId(plan.id)}
                  variant="ghost"
                  size="sm"
                  radius="2xl"
                  fullWidth
                  data-testid={`billing-plan-${plan.id}`}
                  className="h-full justify-start p-0 text-left hover:bg-transparent data-[hovered]:bg-transparent"
                >
                  <Card
                    tone={isSelected ? "success" : "default"}
                    radius="2xl"
                    shadow="none"
                    padding="md"
                    className={[
                      "h-full w-full",
                      isSelected
                        ? "border-primary-300/90 shadow-sm shadow-primary-500/10 dark:border-primary-400/60"
                        : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <Text as="p" variant="subtitle" tone="primary" className="truncate">
                          {plan.name}
                        </Text>
                        <Text as="p" variant="bodyStrong" tone="secondary">
                          {priceLabel}
                        </Text>
                      </div>
                      {isCurrent ? (
                        <Badge size="sm" tone="success">
                          Current
                        </Badge>
                      ) : null}
                    </div>
                    <Text variant="body" tone="secondary" className="mt-3">
                      {plan.description}
                    </Text>
                    <Text variant="caption" tone="muted" className="mt-2">
                      {formatUnits(plan.creditLimit, unitLabel)}/day · {plan.maxActiveTunnels}{" "}
                      {LIVE_CONNECTIONS_PLURAL} · {plan.maxActiveHostedRuntimes} hosted runtimes
                    </Text>
                  </Card>
                </Button>
              );
            })}
          </div>
          <Button
            onPress={
              isPortalDowngrade
                ? handleManageSubscription
                : isPaidPlanSwitch
                  ? handlePlanChange
                  : handleCheckout
            }
            isDisabled={
              !controllerEnabled ||
              Boolean(activation) ||
              (isPortalDowngrade
                ? portalPending
                : isPaidPlanSwitch
                  ? planChangePending
                  : checkoutPending) ||
              !selectedPlan ||
              selectedPlanIsCurrent
            }
            variant="primary"
            size="md"
            radius="2xl"
            fullWidth
            data-testid="billing-plan-cta"
          >
            {selectedPlanIsCurrent
              ? "Current plan"
              : activation
                ? "Activating your plan…"
                : isPortalDowngrade
                  ? portalPending
                    ? "Opening portal…"
                    : "Downgrade in billing portal"
                  : isPaidPlanSwitch
                    ? planChangePending
                      ? "Switching plan…"
                      : armedPlanChangeId === selectedPlan?.id
                        ? `Confirm switch to ${selectedPlan?.name ?? "plan"}`
                        : `Switch to ${selectedPlan?.name ?? "plan"}`
                    : checkoutPending
                      ? "Starting checkout…"
                      : `Continue with ${selectedPlan?.name ?? "plan"}`}
          </Button>
          {isPortalDowngrade ? (
            <Text variant="caption" tone="muted" className="mt-2" data-testid="billing-downgrade-hint">
              To move to {selectedPlan?.name}, cancel your subscription in the billing portal. Your current
              plan stays active until the end of the billing period.
            </Text>
          ) : null}
          {isPaidPlanSwitch ? (
            <Text variant="caption" tone="muted" className="mt-2" data-testid="billing-plan-change-hint">
              Switching updates your existing subscription — no second subscription is created.
              {isPaidPlanUpgrade
                ? " The prorated difference is charged immediately."
                : " The prorated difference is credited toward your next invoice."}
            </Text>
          ) : null}
        </div>
      ) : null}

      {section === "activity" ? (
        <Card radius="2xl" shadow="sm" padding="md" className="space-y-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1">
              <Heading level={3} variant="subtitle">
                Recent balance activity
              </Heading>
              {personal ? null : (
                <Text variant="caption" tone="muted">
                  AI, runtime, and live access spend all land in this shared ledger.
                </Text>
              )}
            </div>
            <div className="flex items-center gap-2">
              {activityView === "graph" ? (
                <SegmentedControl<CreditActivityRange> aria-label="Activity graph range" value={graphRange} onChange={setGraphRange} width="fit"
                  options={[
                    { value: "7d", label: "7D", testId: "credits-graph-range-7d" },
                    { value: "30d", label: "30D", testId: "credits-graph-range-30d" },
                  ]} />
              ) : null}
              <SegmentedControl aria-label="Activity view" value={activityView} onChange={setActivityView} width="fit"
                options={[
                  { value: "log", label: "Log", testId: "credits-activity-view-log" },
                  { value: "graph", label: "Graph", testId: "credits-activity-view-graph" },
                ]} />
            </div>
          </div>

          {ledgerError ? (
            <Text variant="body" tone="danger" className="font-medium">
              {ledgerError}
            </Text>
          ) : (activityView === "graph" ? ledger.length === 0 : recentActivity.length === 0) ? (
            <Text variant="body" tone="secondary">
              No balance activity recorded yet.
            </Text>
          ) : activityView === "graph" ? (
            <CreditActivityChart
              entries={ledger}
              amountMode={amountView}
              unitLabel={unitLabel}
              currency={displayCurrency}
              unitsPerUsd={unitsPerUsd}
              currentBalance={creditBalance}
              balanceLimit={creditLimit}
              range={graphRange}
            />
          ) : (
            <div className="divide-y divide-slate-200/70 dark:divide-slate-800">
              {recentActivity.map((row, index) => {
                const deltaClass = row.delta >= 0 ? "text-primary-600" : "text-rose-600";
                const takesFocus = index === activityFocusRow;
                return (
                  <div
                    key={row.key}
                    ref={takesFocus ? activityFocusRowRef : undefined}
                    tabIndex={takesFocus ? -1 : undefined}
                    className={
                      takesFocus
                        ? "py-2.5 focus:outline-none focus-visible:rounded-lg focus-visible:ring-2 focus-visible:ring-primary-400 dark:focus-visible:ring-primary-300/80"
                        : "py-2.5"
                    }
                    data-testid="credit-ledger-entry"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <Text
                          as="p"
                          variant="body"
                          tone="primary"
                          className="truncate font-medium leading-tight"
                          title={row.label}
                        >
                          {row.label}
                        </Text>
                        <Text
                          as="p"
                          variant="caption"
                          tone="muted"
                          className="mt-0.5 truncate font-medium leading-tight"
                        >
                          {/* A turn from another space names it, as Home's rows do. */}
                          {[row.space, new Date(row.createdAt).toLocaleString()].filter(Boolean).join(" · ")}
                        </Text>
                      </div>

                      <Text
                        as="p"
                        variant="bodyStrong"
                        tone="inherit"
                        className={`shrink-0 text-right tabular-nums leading-tight ${deltaClass}`}
                        data-testid="credit-ledger-delta"
                      >
                        {formatDeltaValue(row.delta)}
                      </Text>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {!ledgerError && activityView === "log" && hasMoreActivity ? (
            <Button
              variant="ghost"
              size="sm"
              radius="xl"
              onPress={showMoreActivity}
              data-testid="credits-activity-show-more"
            >
              Show more
            </Button>
          ) : null}
        </Card>
      ) : null}
    </SettingsShell>
  );
}
