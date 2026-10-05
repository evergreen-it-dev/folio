import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../i18n/register';

const RESUME_KEY = 'folio.oauthResumeAt';
const RESUME_WINDOW_MS = 15_000;

/**
 * `/oauth/authorize` is a SERVER page (the consent screen). A logged-out visitor gets the SPA at
 * that URL so the usual login screen appears; once the session exists this route is what renders,
 * and it simply asks the server for the same URL again, which now shows the consent screen.
 * A short-lived sessionStorage stamp stops a reload loop if the browser keeps refusing the cookie.
 */
export function OAuthResume() {
  const { t } = useTranslation('app');
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    let recent = false;
    try {
      recent = Date.now() - Number(sessionStorage.getItem(RESUME_KEY) ?? 0) < RESUME_WINDOW_MS;
      if (!recent) sessionStorage.setItem(RESUME_KEY, String(Date.now()));
    } catch {
      // storage blocked: one reload attempt is still safe, the server decides what to show
    }
    if (recent) setStuck(true);
    else window.location.reload();
  }, []);

  return <p className="p-6 text-sm text-neutral-500">{stuck ? t('oauth.resumeFailed') : t('oauth.resuming')}</p>;
}
