/** @jsxImportSource react */
import { useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, Box, Check, CheckCircle2, ChevronRight, Copy, LoaderCircle, Power, RotateCcw, XCircle } from "lucide-react";

import type { MarsWorkspaceBox } from "@/app/lib/mars-server";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Progress as ProgressPrimitive } from "@base-ui/react/progress";
import { ProgressIndicator, ProgressTrack } from "@/components/ui/progress";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ConfirmModal } from "@/react-app/design-system/modals/confirm-modal";

import {
  LINUX_SANDBOX_HELP,
  linuxSandboxBackendChoices,
  linuxSandboxBackendSummary,
  linuxSandboxView,
  type LinuxSandboxNextStep,
  type LinuxSandboxPending,
  type LinuxSandboxProblem,
  type LinuxSandboxView,
} from "./linux-sandbox";

export type LinuxSandboxCardProps = {
  box: MarsWorkspaceBox | null;
  pending: LinuxSandboxPending;
  problem: LinuxSandboxProblem | null;
  notice: string;
  onToggle: (enabled: boolean) => void;
  onRetry: () => void;
  onReset: () => void;
  onBackend?: (backend: string) => void;
  /** Opens the Advanced section from the start (tests, a link to the backend). */
  defaultAdvancedOpen?: boolean;
};

const TONE_CLASS: Record<LinuxSandboxView["tone"], string> = {
  off: "text-dls-secondary",
  busy: "text-dls-secondary",
  ready: "text-green-11",
  attention: "text-amber-11",
  error: "text-red-11",
};

function ToneIcon({ tone }: { tone: LinuxSandboxView["tone"] }) {
  const className = `mt-px size-4 shrink-0 ${TONE_CLASS[tone]}`;
  switch (tone) {
    case "busy":
      return <LoaderCircle aria-hidden className={`${className} motion-safe:animate-spin`} />;
    case "ready":
      return <CheckCircle2 aria-hidden className={className} />;
    case "attention":
      return <AlertTriangle aria-hidden className={className} />;
    case "error":
      return <XCircle aria-hidden className={className} />;
    default:
      return <Power aria-hidden className={className} />;
  }
}

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1_500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className="mt-2 flex items-center gap-2 rounded-lg border border-dls-border bg-dls-hover py-1 pl-3 pr-1">
      <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-dls-text" title={command} data-testid="linux-sandbox-command">{command}</code>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={copied ? "Copied" : "Copy command"}
        onClick={() => void navigator.clipboard?.writeText(command).then(() => setCopied(true)).catch(() => undefined)}
      >
        {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      </Button>
    </div>
  );
}

function NextStep({ step }: { step: LinuxSandboxNextStep }) {
  return (
    <div className="text-[11px] text-dls-secondary" data-testid="linux-sandbox-next-step">
      <div className="mt-1">{step.detail}</div>
      {step.command ? <CopyCommand command={step.command} /> : null}
    </div>
  );
}

function Details({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="mt-1 inline-flex items-center gap-0.5 rounded text-[11px] text-dls-secondary underline-offset-2 hover:text-dls-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dls-border">
        <ChevronRight aria-hidden className={`size-3 motion-safe:transition-transform ${open ? "rotate-90" : ""}`} />
        {open ? "Hide details" : "Show details"}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-dls-border bg-dls-hover p-2 font-mono text-[11px] text-dls-secondary" data-testid="linux-sandbox-error-detail">{text}</pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** The status row: one icon, one title, one line (or the download bar), one button; same height in every state. */
function StatusRow(props: { view: LinuxSandboxView; busy: boolean; onAction: () => void }) {
  const { view } = props;
  return (
    <div className="px-4 py-3" data-testid="linux-sandbox-status" data-tone={view.tone}>
      <div className="flex min-h-9 items-start gap-3">
        <ToneIcon tone={view.tone} />
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-medium text-dls-text" role="status" aria-live="polite" data-testid="linux-sandbox-state">{view.title}</div>
          {view.progress ? (
            <ProgressPrimitive.Root
              value={view.progress.value}
              aria-label="Sandbox download"
              getAriaValueText={() => view.progress?.label ?? ""}
              className="flex h-[18px] items-center gap-2"
              data-testid="linux-sandbox-progress"
            >
              <ProgressTrack className="h-1.5 flex-1 bg-dls-hover">
                <ProgressIndicator className={`rounded-full bg-dls-text/70 motion-safe:duration-500 motion-reduce:transition-none ${view.progress.value === null ? "w-1/4 motion-safe:animate-pulse" : ""}`} />
              </ProgressTrack>
              <span className="shrink-0 text-[11px] tabular-nums text-dls-secondary">{view.progress.label}</span>
            </ProgressPrimitive.Root>
          ) : view.detail ? (
            <div className="text-[11px] leading-[18px] text-dls-secondary" data-testid="linux-sandbox-detail">{view.detail}</div>
          ) : null}
          {view.step ? <NextStep step={view.step} /> : null}
          {view.errorDetail ? <Details text={view.errorDetail} /> : null}
        </div>
        {view.action ? (
          <Button variant="outline" size="xs" disabled={props.busy} onClick={props.onAction}>
            {view.action.kind === "auto-backend" ? null : <RotateCcw aria-hidden />}
            {view.action.label}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function Advanced(props: { box: MarsWorkspaceBox; busy: boolean; defaultOpen: boolean; onBackend?: (backend: string) => void; onReset: () => void }) {
  const { box } = props;
  const [open, setOpen] = useState(props.defaultOpen);
  const [confirmReset, setConfirmReset] = useState(false);
  const selectId = useId();
  const choices = linuxSandboxBackendChoices(box);
  const others = (box.backend?.alternatives ?? []).filter((alt) => alt.id !== box.backend?.id);
  const lockedByEnv = box.backendSetting.source === "env";
  const canReset = Boolean(box.container?.exists);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-t border-dls-border">
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded-b-2xl px-4 py-2.5 text-left text-[12px] text-dls-secondary hover:text-dls-text focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dls-border" data-testid="linux-sandbox-advanced">
        <ChevronRight aria-hidden className={`size-3.5 motion-safe:transition-transform ${open ? "rotate-90" : ""}`} />
        <span className="font-medium">Advanced</span>
        <span className={`ml-auto truncate text-[11px] ${open ? "invisible" : ""}`}>{choices.find((choice) => choice.value === box.backendSetting.value)?.label ?? box.backendSetting.value}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-4 px-4 pb-4 pt-1">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="min-w-0 flex-1">
              <label htmlFor={selectId} className="text-[12px] font-medium text-dls-text">Backend</label>
              <div className="text-[11px] text-dls-secondary" data-testid="linux-sandbox-backend">{linuxSandboxBackendSummary(box)}</div>
            </div>
            {props.onBackend ? (
              <div className="w-full sm:w-56">
                <Select
                  value={box.backendSetting.value}
                  items={choices}
                  onValueChange={(value) => {
                    if (typeof value === "string" && value !== box.backendSetting.value) props.onBackend?.(value);
                  }}
                  disabled={props.busy || lockedByEnv}
                >
                  <SelectTrigger id={selectId} className="w-full" aria-label="Sandbox backend">
                    <SelectValue placeholder="Automatic (recommended)" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {choices.map((item) => (
                        <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
            ) : null}
          </div>
          {others.length ? (
            <div>
              <div className="text-[11px] font-medium text-dls-secondary">Other backends on this computer</div>
              <ul className="mt-1 space-y-0.5" data-testid="linux-sandbox-others">
                {others.map((alt) => (
                  <li key={alt.id} className="flex min-w-0 items-baseline gap-2 text-[11px]">
                    <span aria-hidden className={`size-1.5 shrink-0 translate-y-[-1px] rounded-full ${alt.ok ? "bg-green-9" : "bg-gray-7"}`} />
                    <span className="shrink-0 text-dls-text">{alt.label}</span>
                    <span className="min-w-0 truncate text-dls-secondary" title={alt.reason ?? undefined}>{alt.ok ? "available" : alt.reason ?? "not available"}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="min-w-0 flex-1">
              <div className="text-[12px] font-medium text-dls-text">Reset sandbox</div>
              <div className="text-[11px] text-dls-secondary">
                {canReset ? "Removes this project's container and everything installed in it. Your project files are not touched." : "Nothing to reset: this project has no sandbox yet."}
              </div>
            </div>
            <Button variant="destructive" size="xs" disabled={props.busy || !canReset} onClick={() => setConfirmReset(true)}>Reset…</Button>
          </div>
        </div>
      </CollapsibleContent>
      <ConfirmModal
        open={confirmReset}
        variant="danger"
        title="Reset the sandbox?"
        message="This removes the project's Linux container and everything installed in it. Your project files stay as they are. The next command starts a fresh sandbox."
        confirmLabel="Reset sandbox"
        cancelLabel="Cancel"
        onCancel={() => setConfirmReset(false)}
        onConfirm={() => {
          setConfirmReset(false);
          props.onReset();
        }}
      />
    </Collapsible>
  );
}

/**
 * Settings > General > Linux sandbox (beta), for the selected project: the
 * switch, one status row, the server's offer, and the backend and Reset
 * under Advanced.
 */
export function LinuxSandboxCard(props: LinuxSandboxCardProps) {
  const { box, pending } = props;
  const [offerDismissed, setOfferDismissed] = useState(false);
  const switchId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  // Opened from the composer's sandbox chip (#linux-sandbox): bring the card into view.
  useEffect(() => {
    if (typeof window === "undefined" || window.location.hash !== "#linux-sandbox") return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    sectionRef.current?.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
  }, []);
  const busy = pending !== null;
  // The switch shows the user's choice at once; the server's answer follows.
  const checked = pending === "on" ? true : pending === "off" ? false : box?.on === true;
  const view = box ? linuxSandboxView(box, pending) : null;
  const showOffer = Boolean(box?.offer && !box.on && !busy && !offerDismissed);
  const action = () => {
    if (view?.action?.kind === "auto-backend") props.onBackend?.("auto");
    else props.onRetry();
  };
  return (
    <section ref={sectionRef} className="scroll-mt-6 space-y-3" id="linux-sandbox" aria-labelledby={`${switchId}-heading`} data-testid="linux-sandbox-card">
      <div id={`${switchId}-heading`} className="text-[11px] font-semibold uppercase tracking-[0.15em] text-dls-secondary">Linux sandbox</div>
      <div className="rounded-2xl border border-dls-border bg-dls-surface">
        <div className="flex items-center gap-4 p-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-hover">
            <Box size={17} aria-hidden className={box?.on && box.state === "ready" ? "text-green-11" : "text-dls-secondary"} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <label htmlFor={switchId} className="text-[13px] font-medium text-dls-text">Run commands in a Linux sandbox</label>
              <span className="rounded-full border border-dls-border px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-dls-secondary">Beta</span>
            </div>
            <div id="linux-sandbox-help" className="text-[11px] text-dls-secondary">{LINUX_SANDBOX_HELP}</div>
            {/* TODO(Sam): data-collection wording for sandboxed chats goes here (what uploads record about the
                sandbox: Linux as the OS, the container image, per-turn changes outside the project). No copy yet. */}
          </div>
          <Switch
            id={switchId}
            aria-label="Run commands in a Linux sandbox"
            aria-describedby="linux-sandbox-help"
            aria-busy={busy || undefined}
            checked={checked}
            disabled={busy || !box || box.source === "env"}
            onCheckedChange={props.onToggle}
          />
        </div>

        {showOffer ? (
          <div className="mx-4 mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-dls-border bg-dls-hover px-3 py-2" data-testid="linux-sandbox-offer">
            <div className="min-w-0 flex-1 text-[11px] text-dls-text">Your marsai.click server recommends the sandbox for this project.</div>
            <div className="flex items-center gap-1.5">
              <Button size="xs" onClick={() => props.onToggle(true)}>Turn on</Button>
              <Button size="xs" variant="ghost" onClick={() => setOfferDismissed(true)}>Not now</Button>
            </div>
          </div>
        ) : null}

        <div className="border-t border-dls-border">
          {view ? (
            <StatusRow view={view} busy={busy} onAction={action} />
          ) : (
            <div className="px-4 py-3" data-testid="linux-sandbox-status" data-tone="loading">
              <div className="flex min-h-9 items-start gap-3">
                <LoaderCircle aria-hidden className="mt-px size-4 shrink-0 text-dls-secondary motion-safe:animate-spin" />
                <div className="text-[12px] text-dls-secondary" role="status">Checking the sandbox…</div>
              </div>
            </div>
          )}
          {props.problem || props.notice ? (
            <div className="-mt-1 flex items-center gap-2 px-4 pb-3 pl-11 text-[11px]" data-testid="linux-sandbox-message">
              <span className={props.problem ? "text-red-11" : "text-dls-secondary"} role={props.problem ? "alert" : "status"}>{props.problem?.message ?? props.notice}</span>
              {props.problem?.retry ? (
                <Button variant="link" size="xs" className="h-auto px-0" onClick={props.problem.retry}>Try again</Button>
              ) : null}
            </div>
          ) : null}
        </div>

        {box ? <Advanced box={box} busy={busy} defaultOpen={props.defaultAdvancedOpen ?? false} onBackend={props.onBackend} onReset={props.onReset} /> : null}
      </div>
    </section>
  );
}
