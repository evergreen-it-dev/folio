import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ExternalLink } from 'lucide-react';
import { api } from '../api';
import { publicSettingsKey } from '../sidebar/PublishSpaceDialog';
import { AssetPicker } from './AssetControls';
import { PublishSummaryCard } from './PublishSummaryCard';
import { RepoFileBadge } from './RepoFileBadge';
import { SaveBar } from './SaveBar';
import { SeoPreview } from './SeoPreview';
import {
  COMMON_LANGUAGES,
  DESCRIPTION_SOFT_LIMIT,
  canonicalBaseOf,
  parseSiteJson,
  robotsAndSitemapUrls,
  siteFieldErrors,
  siteString,
  siteSwitchOn,
  withSiteField,
  withSiteSwitch,
} from './appearanceLogic';
import type { AppearanceController } from './useAppearance';
import '../i18n/register';

const fieldClass =
  'w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-800 outline-none focus:border-neutral-500 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100';
const labelClass = 'mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-300';
const OTHER = '__other__';

/**
 * Tab 1: how the site is published (stored in Folio) and how it presents itself to search engines and link cards
 * (`.folio/site.json`). `publishOnly` is the instance admin's view of a space whose repository files they may not edit.
 */
export function SiteTab({ space, spaceName, controller, publishOnly }: { space: string; spaceName: string; controller: AppearanceController; publishOnly?: boolean }) {
  const { t } = useTranslation('app');
  const publicQuery = useQuery({ queryKey: publicSettingsKey(space), queryFn: () => api.getSpacePublicSettings(space), retry: false });
  const response = publicQuery.data;

  const raw = controller.value('site.json');
  const parsed = parseSiteJson(raw);
  const values = parsed.ok ? parsed.value : {};
  const errors = parsed.ok ? siteFieldErrors(values) : {};
  const invalid = !parsed.ok || Object.keys(errors).length > 0;
  const set = (key: string, value: string) => controller.setValue('site.json', withSiteField(controller.value('site.json'), key, value));

  const [forceOtherLang, setForceOtherLang] = useState(false);
  const lang = siteString(values, 'lang');
  const known = COMMON_LANGUAGES.some((l) => l.code === lang);
  const otherLang = forceOtherLang || (lang !== '' && !known);

  const assets = controller.data?.assets ?? [];
  const assetUrl = (name: string) => assets.find((a) => a.name === name)?.url ?? null;
  const description = siteString(values, 'description');
  const links = response ? robotsAndSitemapUrls(response) : null;
  const locked = !parsed.ok;

  if (publishOnly) {
    return <PublishSummaryCard space={space} response={response} loading={publicQuery.isLoading} failed={publicQuery.isError} />;
  }

  return (
    <div className="space-y-6">
      <PublishSummaryCard space={space} response={response} loading={publicQuery.isLoading} failed={publicQuery.isError} />

      <section aria-labelledby="settings-seo" className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 id="settings-seo" className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
          {t('spaceSettings.seo.title')}
        </h2>
        <p className="mb-3 mt-1 text-xs text-neutral-500 dark:text-neutral-400">{t('spaceSettings.seo.intro')}</p>
        {controller.data && (
          <RepoFileBadge
            file="site.json"
            state={controller.fileState('site.json')}
            contentRoot={controller.data.contentRoot}
            repoFileBaseUrl={controller.data.repoFileBaseUrl}
          />
        )}
        {locked && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{t('spaceSettings.seo.invalidJson')}</p>}

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div>
            <label htmlFor="seo-title" className={labelClass}>
              {t('spaceSettings.seo.siteTitle')}
            </label>
            <input
              id="seo-title"
              value={siteString(values, 'title')}
              onChange={(e) => set('title', e.target.value)}
              placeholder={spaceName}
              maxLength={80}
              disabled={locked}
              aria-invalid={Boolean(errors.title)}
              className={fieldClass}
            />
          </div>
          <div>
            <label htmlFor="seo-tagline" className={labelClass}>
              {t('spaceSettings.seo.tagline')}
            </label>
            <input
              id="seo-tagline"
              value={siteString(values, 'tagline')}
              onChange={(e) => set('tagline', e.target.value)}
              maxLength={160}
              disabled={locked}
              aria-invalid={Boolean(errors.tagline)}
              className={fieldClass}
            />
          </div>

          <div className="md:col-span-2">
            <label htmlFor="seo-description" className={labelClass}>
              {t('spaceSettings.seo.description')}
            </label>
            <textarea
              id="seo-description"
              value={description}
              onChange={(e) => set('description', e.target.value)}
              rows={3}
              maxLength={300}
              disabled={locked}
              aria-invalid={Boolean(errors.description)}
              className={fieldClass}
            />
            <p className={`mt-1 text-xs ${description.length > DESCRIPTION_SOFT_LIMIT ? 'text-amber-600 dark:text-amber-400' : 'text-neutral-500 dark:text-neutral-400'}`}>
              <span data-testid="seo-description-count">{t('spaceSettings.seo.descriptionCount', { count: description.length, limit: DESCRIPTION_SOFT_LIMIT })}</span>
              {' · '}
              {t('spaceSettings.seo.descriptionHint')}
            </p>
          </div>

          <div>
            <label htmlFor="seo-lang" className={labelClass}>
              {t('spaceSettings.seo.lang')}
            </label>
            <select
              id="seo-lang"
              value={otherLang ? OTHER : lang}
              disabled={locked}
              onChange={(e) => {
                if (e.target.value === OTHER) {
                  setForceOtherLang(true);
                } else {
                  setForceOtherLang(false);
                  set('lang', e.target.value);
                }
              }}
              className={fieldClass}
            >
              <option value="">{t('spaceSettings.seo.langDefault')}</option>
              {COMMON_LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
              <option value={OTHER}>{t('spaceSettings.seo.langOther')}</option>
            </select>
            {otherLang && (
              <div className="mt-1.5">
                <input
                  value={lang}
                  onChange={(e) => set('lang', e.target.value.trim())}
                  aria-label={t('spaceSettings.seo.langCustom')}
                  placeholder="en-GB"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  disabled={locked}
                  aria-invalid={Boolean(errors.lang)}
                  className={fieldClass}
                />
                {errors.lang && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{t('spaceSettings.seo.langInvalid')}</p>}
              </div>
            )}
          </div>

          <div className="md:col-span-2">
            <label className="flex items-start gap-2 text-sm text-neutral-800 dark:text-neutral-100">
              <input
                id="seo-llms"
                type="checkbox"
                className="mt-0.5"
                checked={siteSwitchOn(values, 'llms')}
                disabled={locked}
                onChange={(e) => controller.setValue('site.json', withSiteSwitch(controller.value('site.json'), 'llms', e.target.checked))}
              />
              <span>
                {t('spaceSettings.seo.llms')}
                <span className="block text-xs text-neutral-500 dark:text-neutral-400">{t('spaceSettings.seo.llmsHint')}</span>
              </span>
            </label>
          </div>

          <div className="md:col-span-2 grid gap-4 md:grid-cols-3">
            <AssetPicker
              id="seo-og-image"
              label={t('spaceSettings.seo.ogImage')}
              value={siteString(values, 'ogImage')}
              assets={assets}
              onChange={(name) => set('ogImage', name)}
              controller={controller}
              disabled={locked}
            />
            <AssetPicker
              id="seo-favicon"
              label={t('spaceSettings.seo.favicon')}
              value={siteString(values, 'favicon')}
              assets={assets}
              onChange={(name) => set('favicon', name)}
              controller={controller}
              disabled={locked}
            />
            <AssetPicker
              id="seo-logo"
              label={t('spaceSettings.seo.logo')}
              value={siteString(values, 'logo')}
              assets={assets}
              onChange={(name) => set('logo', name)}
              controller={controller}
              disabled={locked}
            />
          </div>
        </div>

        {Object.keys(errors).length > 0 && (
          <p role="alert" className="mt-3 text-xs text-red-600 dark:text-red-400">
            {t('spaceSettings.seo.invalidFields', { fields: Object.keys(errors).join(', ') })}
          </p>
        )}

        <div className="mt-5">
          <SeoPreview
            address={response ? canonicalBaseOf(response) : ''}
            title={siteString(values, 'title') || spaceName}
            description={description || siteString(values, 'tagline')}
            faviconUrl={assetUrl(siteString(values, 'favicon'))}
            ogImageUrl={assetUrl(siteString(values, 'ogImage'))}
          />
        </div>

        <div className="mt-5 space-y-1.5 text-xs text-neutral-500 dark:text-neutral-400">
          <p>{t('spaceSettings.seo.pageDescriptionHint')}</p>
          {links && (
            <p className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <a href={links.robots} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-blue-600 hover:underline dark:text-blue-400">
                robots.txt <ExternalLink size={11} aria-hidden="true" />
              </a>
              <a href={links.sitemap} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-blue-600 hover:underline dark:text-blue-400">
                sitemap.xml <ExternalLink size={11} aria-hidden="true" />
              </a>
              {siteSwitchOn(values, 'llms') && (
                <a href={links.llms} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-blue-600 hover:underline dark:text-blue-400">
                  llms.txt <ExternalLink size={11} aria-hidden="true" />
                </a>
              )}
            </p>
          )}
        </div>
      </section>

      <SaveBar tab="site" controller={controller} invalid={invalid} />
    </div>
  );
}
