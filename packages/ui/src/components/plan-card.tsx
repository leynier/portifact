import { Check, Clock } from "lucide-react";
import type { ReactNode } from "react";
import { PLAN_CARD_CLASSES as c } from "../static/plans.ts";
import { Badge } from "./badge.tsx";

export interface PlanCardProps {
  /** A stable key for the plan, used in IDs and `data-plan`. */
  id: string;
  name: string;
  summary: string;
  price: { amount: string; unit: string };
  includedLabel: string;
  included: readonly string[];
  comingSoonLabel: string;
  comingSoon: readonly string[];
  /** Marks the plan the space is on with this label, such as "Current plan". */
  currentLabel?: string | undefined;
  /** The call to action, or a note for someone who cannot act on it. */
  action?: ReactNode;
  headingLevel?: 2 | 3;
}

function FeatureList({
  label,
  items,
  soon,
}: {
  label: string;
  items: readonly string[];
  soon: boolean;
}) {
  if (items.length === 0) return null;
  const Icon = soon ? Clock : Check;
  return (
    <div>
      <p className={c.listLabel}>{label}</p>
      <ul className={c.list}>
        {items.map((item) => (
          <li key={item} className={soon ? c.soonItem : c.item}>
            <Icon aria-hidden="true" className={c.icon} />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * One plan: its name, who it is for, its price, the features it includes, the features still on
 * the way (marked by a label and an icon, never by tone alone) and its action. The landing draws
 * the same card as static HTML (`planCardHtml` in `@portifact/ui/plans`).
 */
export function PlanCard({
  id,
  name,
  summary,
  price,
  includedLabel,
  included,
  comingSoonLabel,
  comingSoon,
  currentLabel,
  action,
  headingLevel = 3,
}: PlanCardProps) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <article className={c.card} aria-labelledby={`plan-${id}-name`} data-plan={id}>
      <div className={c.header}>
        <div className={c.nameRow}>
          <Heading id={`plan-${id}-name`} className={c.name}>
            {name}
          </Heading>
          {currentLabel ? <Badge emphasis="strong">{currentLabel}</Badge> : null}
        </div>
        <p className={c.summary}>{summary}</p>
      </div>
      <p className={c.price}>
        <span className={c.amount}>{price.amount}</span>
        {price.unit ? <span className={c.unit}>{price.unit}</span> : null}
      </p>
      <FeatureList label={includedLabel} items={included} soon={false} />
      <FeatureList label={comingSoonLabel} items={comingSoon} soon />
      {action ? <div className={c.action}>{action}</div> : null}
    </article>
  );
}
