import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PageMeta } from '@shared/contracts';
import { api } from '../api';
import { useApiErrorText } from '../errorText';
import { useAuth } from '../auth/AuthProvider';
import { t } from '../i18n/register';
import '../i18n/register';
import { getTemplatePages, getTopLevelNodes } from '../sidebar/treeUtils';
import { substituteTemplate, todayDateStamp } from '../template';

export interface TemplateOption {
  id: string;
  title: string;
}

/**
 * Templates available for "create from template" (DEV-PLAN Round 5): tries
 * the dedicated GET /api/spaces/:space/templates endpoint first (a SERVER
 * round-5 item, not confirmed landed — see api.ts's getTemplates docblock),
 * falling back on any error (404 included) to a client-side scan of the
 * already-fetched page tree for the top-level `_templates` folder's direct
 * doc-kind children (treeUtils.ts's getTemplatePages).
 *
 * The tree-scan fallback shares the ['tree', space] query cache with
 * PageTree/Sidebar rather than issuing its own fetch — it's only *enabled*
 * once the endpoint has already failed, but by then the tree is normally
 * already cached (the sidebar showing this menu implies the tree loaded),
 * so it resolves instantly rather than triggering a visible extra request.
 */
export function useTemplates(space: string): { templates: TemplateOption[]; isLoading: boolean } {
  const endpoint = useQuery({
    queryKey: ['templates', space],
    queryFn: () => api.getTemplates(space),
    retry: false,
  });

  const tree = useQuery({
    queryKey: ['tree', space],
    queryFn: () => api.getTree(space),
    enabled: endpoint.isError,
  });

  if (endpoint.data) {
    return { templates: endpoint.data.templates.map((p: PageMeta) => ({ id: p.id, title: p.title })), isLoading: false };
  }
  if (endpoint.isError) {
    const nodes = tree.data ? getTemplatePages(getTopLevelNodes(tree.data)) : [];
    return { templates: nodes.map((n) => ({ id: n.id, title: n.title })), isLoading: tree.isLoading };
  }
  return { templates: [], isLoading: endpoint.isFetching };
}

export interface CreateFromTemplateArgs {
  template: TemplateOption;
  /** Parent directory path relative to the space root; "" for space root — same shape as CreatePageBody.parentPath. */
  parentPath: string;
}

/**
 * Create + PUT-with-substitution in one mutation: POST create (title =
 * the template's own title, like any other quick-created page — there's no
 * "name your page" prompt in this flow, matching the existing New
 * page/New board affordances), then GET the template's markdown and PUT it
 * back substituted ({{date}}/{{author}}/{{title}} — see template.ts) onto
 * the freshly created page. The template's own frontmatter (icon/cover, if
 * any) rides along unchanged as part of that same markdown — deliberate:
 * the simplest, most literal reading of "create = POST create + PUT with
 * substitution" is a faithful copy of the template body, not a selective one.
 */
export function useCreateFromTemplate(space: string, onSuccess: (page: PageMeta) => void, onError: (message: string) => void) {
  const errorText = useApiErrorText();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ template, parentPath }: CreateFromTemplateArgs) => {
      const created = await api.createPage({ space, parentPath, title: template.title, kind: 'doc' });
      const source = await api.getPage(template.id);
      const substituted = substituteTemplate(source.markdown ?? '', {
        date: todayDateStamp(),
        author: user.name,
        title: template.title,
      });
      return api.updatePage(created.id, { markdown: substituted });
    },
    onSuccess: (page) => {
      queryClient.invalidateQueries({ queryKey: ['tree', space] });
      onSuccess(page);
    },
    onError: (err) => onError(errorText(err, 'sidebar.templates.createFailed')),
  });
}
