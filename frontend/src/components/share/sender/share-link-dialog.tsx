'use client'

import { useCallback, useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Copy, Link2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { ModalDialog } from '@/components/ui/modal-dialog'
import {
  createShareLink,
  listShareLinks,
  revokeAllShareLinks,
  revokeShareLink,
} from '@/services/api'
import { shareLinkState, shareUrl } from '@/lib/share'
import type { ShareLinkCreated, ShareLinkSummary } from '@/lib/share'
import { formatDate } from '@/lib/utils'

/**
 * The sender's entry point, sitting next to Print/export — the same "give this
 * to my doctor" intent, as the lighter sibling of the printed document.
 *
 * Stage 1 ships ONE configuration (whole record, 7 days, header on) and one
 * dialog for both creating and revoking, so the sender never has to go hunting
 * for what is still out there. The link is offered as copy-to-clipboard: the
 * app is not the courier, and the sender is the one who decides who receives
 * clinical data.
 */
export function ShareLinkButton() {
  const t = useTranslations('share')
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Link2 className="size-3.5" />
        {t('button')}
      </Button>
      <ShareLinkDialog open={open} onClose={() => setOpen(false)} />
    </>
  )
}

function ShareLinkDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslations('share')
  const locale = useLocale()
  const dateLocale = locale === 'ru' ? 'ru-RU' : 'en-US'

  const [links, setLinks] = useState<ShareLinkSummary[]>([])
  const [created, setCreated] = useState<ShareLinkCreated | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const res = await listShareLinks()
      setLinks(res.links)
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    async function load() {
      try {
        const res = await listShareLinks()
        if (!cancelled) {
          setLinks(res.links)
          setFailed(false)
        }
      } catch {
        if (!cancelled) setFailed(true)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [open])

  async function create() {
    setBusy(true)
    setCopied(false)
    try {
      const link = await createShareLink()
      setCreated(link)
      setFailed(false)
      await refresh()
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  async function revoke(id: string) {
    try {
      await revokeShareLink(id)
      await refresh()
    } catch {
      setFailed(true)
    }
  }

  async function revokeAll() {
    try {
      await revokeAllShareLinks()
      await refresh()
    } catch {
      setFailed(true)
    }
  }

  const url = created ? shareUrl(window.location.origin, created.token) : ''
  const activeCount = links.filter((link) => shareLinkState(link) === 'active').length

  return (
    <ModalDialog
      open={open}
      onClose={onClose}
      labelledBy="share-dialog-title"
      panelClassName="max-w-lg"
    >
      <div className="flex max-h-[85vh] flex-col gap-4 overflow-y-auto rounded-lg border border-border bg-card p-5 shadow-lg">
        <div>
          <h2 id="share-dialog-title" className="text-base font-semibold text-foreground">
            {t('dialog.title')}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('dialog.body')}</p>
          <p className="mt-2 text-xs text-muted-foreground">{t('dialog.warning')}</p>
        </div>

        {created ? (
          <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/40 p-3">
            <code className="break-all text-xs text-foreground">{url}</code>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => void copy(url)}>
                <Copy className="size-3.5" />
                {copied ? t('dialog.copied') : t('dialog.copy')}
              </Button>
              <span className="text-xs text-muted-foreground">
                {t('dialog.expires', {
                  date: formatDate(created.expires_at, dateLocale),
                })}
              </span>
            </div>
          </div>
        ) : (
          <div>
            <Button size="sm" onClick={() => void create()} disabled={busy}>
              {busy ? t('dialog.creating') : t('dialog.create')}
            </Button>
          </div>
        )}

        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-foreground">{t('links.title')}</h3>
          {links.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('links.empty')}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {links.map((link) => {
                const state = shareLinkState(link)
                const stamp = link.revoked_at ?? link.expires_at
                return (
                  <li
                    key={link.id}
                    className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-md border border-border px-3 py-2"
                  >
                    <div className="flex flex-col">
                      <span className="text-sm text-foreground">
                        {t(`links.${state}`, {
                          date: formatDate(stamp, dateLocale),
                        })}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {link.first_opened_at
                          ? t('links.opened', {
                              date: formatDate(link.first_opened_at, dateLocale),
                            })
                          : t('links.neverOpened')}
                      </span>
                    </div>
                    {state === 'active' && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void revoke(link.id)}
                      >
                        {t('links.revoke')}
                      </Button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
          {activeCount > 0 && (
            <div>
              <Button variant="ghost" size="sm" onClick={() => void revokeAll()}>
                {t('links.revokeAll')}
              </Button>
            </div>
          )}
        </div>

        {failed && (
          <p className="text-sm text-destructive" role="alert">
            {links.length === 0 ? t('links.loadError') : t('dialog.error')}
          </p>
        )}

        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={onClose}>
            {t('dialog.close')}
          </Button>
        </div>
      </div>
    </ModalDialog>
  )
}
