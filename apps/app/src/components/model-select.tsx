"use client";

import * as React from "react";
import { Check, ChevronDown, Settings2, Star } from "lucide-react";

import type { ModelBehaviorOption, ModelOption, ModelRef } from "@/app/types";
import { getModelBehaviorSummary } from "@/app/lib/model-behavior";
import { ProviderIcon } from "@/react-app/design-system/provider-icon";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useWorkspace } from "@/react-app/shell/workspace-provider";
import { useCheckDesktopRestriction } from "@/react-app/domains/cloud/desktop-config-provider";
import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider";
import { getConnectedProviderItems, useProviderListQuery } from "@/react-app/infra/provider-list-query";
import { filterEntitledModelOptions } from "@/react-app/domains/connections/provider-auth/provider-policy";
import {
  filterCloudManagedModelOptions,
  mergeModelOptions,
} from "@/react-app/domains/connections/provider-auth/assigned-model-options";
import { isCloudManagedProviderKey } from "@/react-app/domains/connections/provider-auth/cloud-provider-config";
import {
  Command,
  CommandCollection,
  CommandEmpty,
  CommandGroup,
  CommandGroupLabel,
  CommandHeader,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
} from "@/components/ui/command";
import { openModelPickerEvent, openProviderAuthEvent } from "@/react-app/shell/new-providers-listener";
import { newProvidersEvent } from "@/app/lib/provider-events";
import {
  modelRefKey,
  useModelCollectionsStore,
} from "@/react-app/domains/session/models/model-collections-store";
import {
  dedupeModelOptions,
  resolveModelDisplayName,
  resolveModelProviderDisplayName,
  resolveMarsModelGroup,
} from "@/app/utils";
import { isSupportedModelProvider, providerCatalogRank } from "@/app/lib/provider-catalog";

function getProviderDisplayName(providerId: string) {
  return providerId
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function useModelOptions(
  open: boolean,
  fallbackOptions: readonly ModelOption[],
  cloudProvidersEnabled: boolean,
) {
  const { client, opencodeBaseUrl, selectedWorkspaceRoot } = useWorkspace();
  const checkDesktopRestriction = useCheckDesktopRestriction();

  const { data, refetch } = useProviderListQuery({
    client,
    baseUrl: opencodeBaseUrl,
    directory: selectedWorkspaceRoot,
    enabled: Boolean(client),
  });

  React.useEffect(() => {
    if (!open || !client) return;
    void refetch();
  }, [client, open, refetch]);

  React.useEffect(() => {
    if (!client) return;
    const handler = () => {
      void refetch();
    };
    window.addEventListener(newProvidersEvent, handler);
    return () => window.removeEventListener(newProvidersEvent, handler);
  }, [client, refetch]);

  // Keep the picker intentionally small: marsai.click-managed models plus the
  // four direct providers supported by the product UI.
  return React.useMemo(() => {
    const restrictToCloud = checkDesktopRestriction({
      restriction: "allowCustomProviders",
    });

    const options = getConnectedProviderItems(data)
      .filter((provider) => isSupportedModelProvider(provider.id))
      .flatMap((provider) =>
        Object.entries(provider.models).map(([id, model]) => {
          const summary = getModelBehaviorSummary(provider.id, model, null, provider.name);
          const group = resolveMarsModelGroup(provider.id, model.family);
          return {
            providerID: provider.id,
            modelID: id,
            title: resolveModelDisplayName(id, model.name),
            description: resolveModelProviderDisplayName(provider.id, id, provider.name, model.name),
            ...(group ? { group } : {}),
            behaviorTitle: summary.title,
            behaviorLabel: summary.label,
            behaviorDescription: summary.description,
            behaviorValue: summary.value,
            behaviorOptions: summary.options,
            isFree: false,
          };
        }),
      );

    const mergedOptions = mergeModelOptions(options, fallbackOptions).filter((option) =>
      isSupportedModelProvider(option.providerID));
    const visibleOptions = cloudProvidersEnabled
      ? mergedOptions
      : mergeModelOptions(
          options.filter((option) => option.providerID.trim().toLowerCase() === "mars"),
          filterCloudManagedModelOptions(mergedOptions, false),
        );

    return filterEntitledModelOptions(visibleOptions, {
      restrictToCloud,
      checkRestriction: checkDesktopRestriction,
    });
  }, [checkDesktopRestriction, cloudProvidersEnabled, data, fallbackOptions]);
}

type ModelSelectItem = {
  id: string;
  option: ModelOption;
};

type ModelSelectGroup = {
  value: string;
  rank: number;
  items: ModelSelectItem[];
};

function groupByProvider(modelOptions: ModelOption[]): ModelSelectGroup[] {
  const groups = new Map<string, ModelSelectItem[]>();

  for (const option of modelOptions) {
    const providerLabel = option.group ?? option.description ?? getProviderDisplayName(option.providerID);
    const item: ModelSelectItem = {
      id: `${option.providerID}:${option.modelID}`,
      option,
    };
    const existing = groups.get(providerLabel);

    if (existing) {
      existing.push(item);
      continue;
    }

    groups.set(providerLabel, [item]);
  }

  return [...groups.entries()]
    .map(([providerLabel, options]) => ({
      value: providerLabel,
      // A family group (Meta Muse) follows its provider's own group.
      rank: Math.min(...options.map(({ option }) => providerCatalogRank(option.providerID) + (option.group ? 0.5 : 0))),
      items: [...options].sort((a, b) => a.option.title.localeCompare(b.option.title)),
    }))
    .sort((a, b) => a.rank - b.rank || a.value.localeCompare(b.value));
}

function isSameModel(a: ModelRef, b: ModelRef) {
  return a.providerID === b.providerID && a.modelID === b.modelID;
}

function thinkingOptionsFor(option: ModelOption): ModelBehaviorOption[] {
  return (option.behaviorOptions ?? []).filter((item) => item.value != null);
}

function overlaySelectedBehavior(
  options: readonly ModelOption[],
  value: ModelRef,
  behavior: {
    value: string | null;
    label?: string;
    options: { value: string | null; label: string }[];
  },
): ModelOption[] {
  return options.map((option) => {
    if (!isSameModel(value, option)) return option;
    const fallbackOptions: ModelBehaviorOption[] = behavior.options.map((item) => ({
      value: item.value,
      label: item.label,
      description: "",
    }));
    return {
      ...option,
      behaviorValue: behavior.value ?? option.behaviorValue,
      behaviorLabel: behavior.label ?? option.behaviorLabel,
      behaviorOptions: (option.behaviorOptions?.length ?? 0) > 0
        ? option.behaviorOptions
        : fallbackOptions,
    };
  });
}

interface ModelSelectProps {
  open: boolean;
  value: ModelRef;
  hideValue?: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (model: ModelRef, variant?: string | null) => void;
  disabled?: boolean;
  /** When set, "All models" opens the full picker scoped to this session. */
  sessionId?: string;
  /** Managed-model entitlement state retained for callers. */
  marsModelsEntitled?: boolean;
  /** The server is waiting to reload managed models for this workspace. */
  marsModelsSyncing?: boolean;
  /** Member-scoped models available before a workspace OpenCode client exists. */
  fallbackOptions?: readonly ModelOption[];
  behaviorValue?: string | null;
  behaviorLabel?: string;
  behaviorOptions?: { value: string | null; label: string }[];
  onBehaviorChange?: (value: string | null) => void;
}

export function ModelSelect({
  open,
  value,
  hideValue = false,
  onOpenChange,
  onChange,
  disabled = false,
  sessionId,
  fallbackOptions = [],
  behaviorValue = null,
  behaviorLabel,
  behaviorOptions = [],
  onBehaviorChange,
}: ModelSelectProps) {
  const [search, setSearch] = React.useState("");
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  const denAuth = useDenAuth();
  const favorites = useModelCollectionsStore((state) => state.favorites);
  const recent = useModelCollectionsStore((state) => state.recent);
  const catalogOptions = useModelOptions(open, fallbackOptions, denAuth.isSignedIn);
  const modelOptions = React.useMemo(
    () => dedupeModelOptions(
      overlaySelectedBehavior(
        catalogOptions,
        value,
        {
          value: behaviorValue,
          label: behaviorLabel,
          options: behaviorOptions,
        },
      ),
    ),
    [behaviorLabel, behaviorOptions, behaviorValue, catalogOptions, value],
  );
  const checkDesktopRestriction = useCheckDesktopRestriction();
  const canAddProviders = !checkDesktopRestriction({ restriction: "allowCustomProviders" });

  const focusSearchInput = React.useCallback(() => {
    window.requestAnimationFrame(() => {
      const input = searchInputRef.current;

      if (!input) {
        return;
      }

      input.focus();
      input.select();
    });
  }, []);

  React.useEffect(() => {
    if (!open) {
      return;
    }

    focusSearchInput();
  }, [focusSearchInput, open]);

  const selectedOption = modelOptions?.find((option) =>
    isSameModel(value, {
      providerID: option.providerID,
      modelID: option.modelID,
    }),
  );
  const selectedModelTitle = selectedOption?.title ?? resolveModelDisplayName(value.modelID);
  const selectedProviderTitle = selectedOption?.description
    ?? resolveModelProviderDisplayName(value.providerID, value.modelID);
  // The first-party desktop route is authenticated by the native Mars
  // account, not the separate Den/cloud session. Never hide a valid local
  // Mars selection merely because the latter is signed out.
  const selectedValueHidden = hideValue || (
    !denAuth.isSignedIn
    && isCloudManagedProviderKey(value.providerID)
    && value.providerID.trim().toLowerCase() !== "mars"
  );

  const optionsByKey = React.useMemo(
    () => new Map(modelOptions.map((option) => [modelRefKey(option), option])),
    [modelOptions],
  );
  const favoriteOptions = React.useMemo(
    () => favorites.flatMap((model) => {
      const option = optionsByKey.get(modelRefKey(model));
      return option ? [option] : [];
    }),
    [favorites, optionsByKey],
  );
  const favoriteKeys = React.useMemo(() => new Set(favorites.map(modelRefKey)), [favorites]);
  const recentOptions = React.useMemo(() => {
    return recent.flatMap((model) => {
      const option = optionsByKey.get(modelRefKey(model));
      return option && !favoriteKeys.has(modelRefKey(model)) ? [option] : [];
    });
  }, [favoriteKeys, optionsByKey, recent]);
  const groups = React.useMemo(() => {
    const quickGroups: ModelSelectGroup[] = [];
    if (favoriteOptions.length > 0) {
      quickGroups.push({
        value: "Favorites",
        rank: -2,
        items: favoriteOptions.map((option) => ({ id: `favorite:${modelRefKey(option)}`, option })),
      });
    }
    if (recentOptions.length > 0) {
      quickGroups.push({
        value: "Recent",
        rank: -1,
        items: recentOptions.map((option) => ({ id: `recent:${modelRefKey(option)}`, option })),
      });
    }
    return [...quickGroups, ...groupByProvider(modelOptions)];
  }, [favoriteOptions, modelOptions, recentOptions]);

  const applyModel = (option: ModelOption, behavior?: string | null) => {
    useModelCollectionsStore.getState().recordRecent(option);
    onChange({ providerID: option.providerID, modelID: option.modelID }, behavior);
    if (behavior !== undefined) {
      onBehaviorChange?.(behavior);
    }
    setSearch("");
    onOpenChange(false);
  };

  // Reasoning effort lives in its own composer control now, so picking a
  // model applies it immediately, keeping the current effort when the model
  // offers the same level and otherwise the model's own default.
  const handleSelect = (option: ModelOption) => {
    const thinking = thinkingOptionsFor(option);
    const compatibleBehavior = isSameModel(value, option)
      && thinking.some((entry) => entry.value === behaviorValue)
      ? behaviorValue
      : option.behaviorValue ?? null;
    applyModel(option, compatibleBehavior);
  };

  const handleConnectProvider = React.useCallback(() => {
    onOpenChange(false);
    setSearch("");
    window.dispatchEvent(new Event(openProviderAuthEvent));
  }, [onOpenChange]);

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen);

        if (!nextOpen) {
          setSearch("");
        }
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              type="button"
              disabled={disabled}
              aria-label="Change model"
              aria-keyshortcuts="Meta+Alt+/"
              data-testid="model-select-trigger"
              // Shrinks (truncating the model name) before it would push into
              // the controls beside it; never below a readable width.
              className="flex h-9 max-h-9 min-w-24 shrink items-center gap-1.5 overflow-hidden rounded-md px-2.5 text-sm text-gray-10 transition-colors hover:bg-gray-3 hover:text-gray-12 disabled:pointer-events-none disabled:opacity-60"
            />
          }
        >
          <span className="flex min-w-0 max-w-64 items-center gap-1.5">
            <span className="min-w-0 truncate">
              {selectedValueHidden || !value.modelID
                ? "Select model"
                : selectedModelTitle}
            </span>
            {!selectedValueHidden && value.modelID && selectedProviderTitle ? (
              <span className="hidden shrink-0 text-xs text-gray-9 @min-[820px]/composer:inline">· {selectedProviderTitle}</span>
            ) : null}
          </span>
          <ChevronDown className="h-3 w-3 shrink-0" />
        </TooltipTrigger>
        <TooltipContent>
          Change model
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        className="w-80 overflow-hidden rounded-2xl bg-popover p-0 shadow-xl ring-1 ring-foreground/5 dark:ring-foreground/10"
        align="start"
        initialFocus={false}
      >
        <div className="flex max-h-[min(var(--available-height),28rem)] flex-col">
          <Command items={groups} value={search} onValueChange={setSearch}>
            <div className="flex min-h-0 flex-1 flex-col">
            <CommandHeader className="p-1.5 pb-1">
              <CommandInput ref={searchInputRef} placeholder="Search models..." className="h-9 text-sm" />
            </CommandHeader>
            <CommandPanel className="h-0 min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
              <CommandEmpty>No models found.</CommandEmpty>
              <CommandList className="not-empty:scroll-py-1 not-empty:p-1">
                {(group: ModelSelectGroup) => (
                  <CommandGroup key={group.value} items={group.items} className="[[role=group]+&]:mt-1">
                    <CommandGroupLabel className="px-2 py-1 text-xs">{group.value}</CommandGroupLabel>
                    <CommandCollection>
                      {(item: ModelSelectItem) => {
                        const option = item.option;
                        const favorite = favoriteKeys.has(modelRefKey(option));
                        return (
                          <CommandItem
                            className="min-h-0 gap-2 rounded-lg px-2 py-1.5"
                            key={item.id}
                            value={`${option.providerID}:${option.modelID} ${option.title} ${option.description ?? ""}`}
                            onClick={() => handleSelect(option)}
                            data-checked={isSameModel(value, option)}
                          >
                            <ProviderIcon providerId={option.providerID} providerName={option.description} className="size-3.5 opacity-70" size={14} />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-foreground">{option.title}</span>
                              <span className="block truncate text-xs text-muted-foreground">{option.description ?? getProviderDisplayName(option.providerID)}</span>
                            </span>
                            <button
                              type="button"
                              className="cursor-pointer rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                              aria-label={favorite ? `Remove ${option.title} from favorites` : `Add ${option.title} to favorites`}
                              onPointerDown={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                              }}
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                useModelCollectionsStore.getState().toggleFavorite(option);
                              }}
                            >
                              <Star className="size-3.5" fill={favorite ? "currentColor" : "none"} />
                            </button>
                          </CommandItem>
                        );
                      }}
                    </CommandCollection>
                  </CommandGroup>
                )}
              </CommandList>
            </CommandPanel>
            {canAddProviders ? (
              <div className="border-t border-border px-2 py-1">
                <button type="button" className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground" onClick={handleConnectProvider}>
                  Connect more providers
                </button>
              </div>
            ) : null}
            <div className="border-t border-border px-2 py-1">
              <button
                type="button"
                className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                onClick={() => {
                  onOpenChange(false);
                  setSearch("");
                  window.dispatchEvent(new CustomEvent(openModelPickerEvent, sessionId ? { detail: { sessionId } } : undefined));
                }}
              >
                <Settings2 className="size-3.5" />
                All models
              </button>
            </div>
            </div>
          </Command>
        </div>
      </PopoverContent>
    </Popover>
  );
}
