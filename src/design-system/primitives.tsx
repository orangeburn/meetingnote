"use client";

import Link from "next/link";
import type { ReactNode } from "react";

type ButtonTone = "primary" | "secondary" | "ghost";
type ButtonSize = "md" | "sm";

function cx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export function AppFrame({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <main className={cx("meetingnote-shell ds-app-frame", className)}>{children}</main>;
}

export function PageContainer({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={cx("ds-page-container", className)}>{children}</div>;
}

export function ShellPanel({
  children,
  className = "",
  detail = false,
}: {
  children: ReactNode;
  className?: string;
  detail?: boolean;
}) {
  return <section className={cx("ds-shell-panel", detail && "ds-shell-panel-detail", className)}>{children}</section>;
}

export function SectionHeading({
  eyebrow,
  title,
  description,
  actions,
  compact = false,
}: {
  eyebrow: string;
  title: ReactNode;
  description?: string;
  actions?: ReactNode;
  compact?: boolean;
}) {
  return (
    <header className={cx(compact ? "ds-section-heading-compact" : "ds-section-heading")}>
      <div className="ds-section-copy">
        <p className="ds-eyebrow">{eyebrow}</p>
        <h1 className={compact ? "ds-display-title-compact" : "ds-display-title"}>{title}</h1>
        {description ? <p className="ds-section-description">{description}</p> : null}
      </div>
      {actions ? <div className="ds-section-actions">{actions}</div> : null}
    </header>
  );
}

export function PanelHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="panel-header">
      <div>
        <div className="panel-kicker">{eyebrow}</div>
        <h2 className="panel-title">{title}</h2>
        {description ? <p className="result-subtitle">{description}</p> : null}
      </div>
      {actions}
    </div>
  );
}

export function ButtonLink({
  href,
  children,
  tone = "ghost",
  size = "md",
  className = "",
}: {
  href: string;
  children: ReactNode;
  tone?: ButtonTone;
  size?: ButtonSize;
  className?: string;
}) {
  return (
    <Link href={href} className={cx("ds-button", `ds-button-${tone}`, `ds-button-${size}`, className)}>
      {children}
    </Link>
  );
}

export function Button({
  children,
  tone = "ghost",
  size = "md",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: ButtonTone;
  size?: ButtonSize;
}) {
  return (
    <button {...props} className={cx("ds-button", `ds-button-${tone}`, `ds-button-${size}`, className)}>
      {children}
    </button>
  );
}

export function MetricBadge({ children, status }: { children: ReactNode; status?: string }) {
  return <div className={cx("result-badge", status ? `result-${status}` : "")}>{children}</div>;
}
