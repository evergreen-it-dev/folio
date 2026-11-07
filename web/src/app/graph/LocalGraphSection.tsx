/**
 * "Local graph" beside a page (in the outline panel): the page and its
 * neighbours, depth 1 by default (1–3 here, remembered per space with the rest
 * of the graph settings, which also filter and colour it). The canvas and
 * d3-force load lazily, only once the section is open; the expand button opens
 * the same neighbourhood full size (`/s/<space>/graph?page=<id>`).
 *
 * 16.10.2026 (owner): the depth buttons carry a visible "Depth" label and a
 * tooltip each (1 — direct links, 2 — through one page, 3 — through two); the
 * header collapses the section like a disclosure, remembered globally (not per
 * page); with "Tree structure" on (the default) the page's parent and children
 * — and its siblings at depth 2 — are neighbours too, so a page without links
 * still shows its place; pages of other spaces it links with appear, labelled
 * with their space. The empty state says how to get links, and only shows when
 * there is no neighbour at all.
 */
import { lazy, Suspense, useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { Check, ChevronDown, Maximize2 } from "lucide-react";
import type { GraphNodeKind } from "@shared/contracts";
import { api } from "../api";
import { useLocalStorage } from "../hooks";
import { requestSearch } from "../../markdown/searchEvent";
import { buildGraphView, isPageNode, type ViewNode } from "./graphModel";
import { useGraphSettings } from "./graphSettings";
import { PanelSection } from "../outline/PanelSection";
import { Menu } from "../ui/Menu";
import "../i18n/register";

/** Global (not per page or space): whether the section's body is collapsed. */
export const LOCAL_GRAPH_COLLAPSED_KEY = "folio:local-graph-collapsed";

const GraphCanvas = lazy(() =>
  import("./GraphCanvas").then((m) => ({ default: m.GraphCanvas })),
);

export interface LocalGraphSectionProps {
  space: string;
  pageId: string;
  variant: "docked" | "mobile";
  /** After a node was opened (the mobile drawer closes itself). */
  onNavigate?: () => void;
  first?: boolean;
  trailing?: ReactNode;
}

export function LocalGraphSection({
  space,
  pageId,
  variant,
  onNavigate,
  first,
  trailing,
}: LocalGraphSectionProps) {
  const { t } = useTranslation("app");
  const navigate = useNavigate();
  const [settings, update] = useGraphSettings(space);
  const [collapsed, setCollapsed] = useLocalStorage<boolean>(
    LOCAL_GRAPH_COLLAPSED_KEY,
    false,
  );
  const { data, error } = useQuery({
    queryKey: [
      "page-graph",
      pageId,
      settings.depth,
      settings.direction,
      settings.showTree,
    ],
    queryFn: () =>
      api.getPageGraph(
        pageId,
        settings.depth,
        settings.direction,
        settings.showTree,
      ),
    enabled: !collapsed,
    staleTime: 30_000,
    retry: false,
    placeholderData: (prev) => (prev?.center === pageId ? prev : undefined),
  });
  const groupsKey = JSON.stringify(settings.groups);
  const view = useMemo(
    () =>
      data
        ? buildGraphView(data, settings, data.center, {
            kind: (k: GraphNodeKind) => t(`graph.kinds.${k}`),
            rootFolder: t("graph.groups.rootFolder"),
            otherSpace: t("graph.groups.otherSpace"),
          })
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      data,
      settings.search,
      settings.showTags,
      settings.showFiles,
      settings.showUnresolved,
      settings.showOrphans,
      settings.showTree,
      settings.colorBy,
      groupsKey,
      settings.sizeByDegree,
      settings.nodeSize,
      t,
    ],
  );

  const open = (node: ViewNode) => {
    if (isPageNode(node)) {
      // A page of another space opens in its own space.
      if (node.id !== pageId)
        navigate(
          `/s/${encodeURIComponent(node.space ?? space)}/p/${encodeURIComponent(node.id)}`,
        );
      onNavigate?.();
    } else if (node.kind === "tag") requestSearch(`tag:${node.id.slice(4)}`);
  };

  const depth = Math.min(3, Math.max(1, settings.depth));
  const neighbours = view
    ? view.nodes.filter((n) => isPageNode(n) && n.id !== pageId).length
    : 0;

  const pagesShown = view ? view.nodes.filter(isPageNode).length : 0;
  const expandButton = (
    <button
      type="button"
      onClick={() => {
        navigate(
          `/s/${encodeURIComponent(space)}/graph?page=${encodeURIComponent(pageId)}`,
        );
        onNavigate?.();
      }}
      aria-label={t("graph.local.expand")}
      title={t("graph.local.expand")}
      className="flex h-6 w-6 items-center justify-center rounded-md text-neutral-500 hover:bg-black/[0.045] hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-white/5 dark:hover:text-neutral-200"
    >
      <Maximize2 size={14} aria-hidden="true" />
    </button>
  );

  return (
    <PanelSection
      // The visible label is the short "Graph" plus how many pages it shows; assistive tech hears the full name.
      label={t("graph.title")}
      count={view && pagesShown > 0 ? pagesShown : undefined}
      ariaLabel={t("graph.local.title")}
      first={first}
      actions={collapsed ? undefined : expandButton}
      trailing={trailing}
      open={!collapsed}
      onToggle={() => setCollapsed((v) => !v)}
      toggleTitle={
        collapsed ? t("graph.local.expandSection") : t("graph.local.collapse")
      }
    >
      <div
        className={`relative overflow-hidden rounded-lg border border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900 ${variant === "docked" ? "h-36" : "h-52"}`}
      >
        {view && view.nodes.length > 0 ? (
          <Suspense fallback={null}>
            <GraphCanvas
              key={pageId}
              nodes={view.nodes}
              links={view.links}
              settings={settings}
              onOpen={open}
              onSelect={(n) => n && open(n)}
              compact
              ariaLabel={t("graph.aria", {
                nodes: view.nodes.length,
                links: view.links.length,
              })}
            />
          </Suspense>
        ) : (
          <div className="flex h-full items-center justify-center px-3 text-center text-[11px] text-neutral-400">
            {error
              ? t("graph.error")
              : data
                ? t("graph.local.none")
                : t("ui.loading")}
          </div>
        )}
        {view && neighbours === 0 && view.nodes.length > 0 && (
          <div className="pointer-events-none absolute inset-x-0 bottom-2 px-3 text-center text-[11px] text-neutral-400">
            {t("graph.local.none")}
          </div>
        )}
      </div>
      {/* Not on the canvas: what the graph shows is a quiet line under it, opening the depth menu. */}
      <div
        className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-neutral-500 dark:text-neutral-400"
        data-tour="graph-links"
      >
        <span>{t("graph.local.showing")}</span>
        <Menu
          triggerLabel={t("graph.local.depth")}
          triggerClassName="-ml-0.5 flex items-center gap-0.5 rounded px-1 py-px text-neutral-700 hover:bg-black/[0.045] dark:text-neutral-300 dark:hover:bg-white/5"
          trigger={
            <>
              <span>{t(`graph.local.showLabel${depth}`)}</span>
              <ChevronDown size={12} aria-hidden="true" />
            </>
          }
        >
          {(close) => (
            <div
              role="group"
              aria-label={t("graph.local.depth")}
              className="w-56"
            >
              <div className="px-2.5 pb-1 pt-1.5 text-[11px] text-neutral-500 dark:text-neutral-400">
                {t("graph.local.depthCaption")}
              </div>
              {[1, 2, 3].map((d) => (
                <button
                  key={d}
                  type="button"
                  role="menuitemradio"
                  aria-checked={depth === d}
                  title={t(`graph.local.depthHint${d}`)}
                  onClick={() => {
                    update({ depth: d });
                    close();
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
                >
                  <span className="w-3.5 shrink-0">
                    {depth === d && <Check size={13} aria-hidden="true" />}
                  </span>
                  <span className="truncate">
                    {t(`graph.local.depthRow${d}`)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </Menu>
      </div>
    </PanelSection>
  );
}
