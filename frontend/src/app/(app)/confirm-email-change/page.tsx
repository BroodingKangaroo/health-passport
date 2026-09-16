"use client"

import { Suspense, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import Link from "next/link"
import { useTranslations } from "next-intl"
import { Loader2, MailCheck, ArrowLeft } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { LanguageSwitch } from "@/components/shared/language-switch"
import { confirmEmailChange } from "@/services/api"

function ConfirmEmailChangeForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const t = useTranslations("confirmEmailChange")
  const token = searchParams.get("token") ?? ""
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState("")
  const [done, setDone] = useState(false)

  async function handleConfirm() {
    setError("")
    setIsLoading(true)
    try {
      // Token-driven and public (like reset-password): the link proves
      // control of the NEW address, so no session is required. The switch is
      // triggered by this click rather than on page load, so a link preview
      // or scanner fetching the URL cannot consume the token.
      await confirmEmailChange(token)
      setDone(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : t("unexpectedError"))
    } finally {
      setIsLoading(false)
    }
  }

  if (!token) {
    return (
      <CardContent>
        <div className="space-y-4">
          <div
            className="flex items-center gap-2 rounded-lg border border-status-high/20 bg-status-high/5 p-3 text-sm text-status-high"
            role="alert"
          >
            {t("invalidLink")}
          </div>
          <Link
            href="/login"
            className="flex items-center justify-center gap-2 text-sm text-primary hover:underline font-medium"
          >
            <ArrowLeft className="size-4" />
            {t("requestNewLink")}
          </Link>
        </div>
      </CardContent>
    )
  }

  return (
    <CardContent>
      {done ? (
        <div className="space-y-4">
          <div className="rounded-lg border border-status-normal/20 bg-status-normal/5 p-3 text-sm text-status-normal">
            {t("done")}
          </div>
          <Button onClick={() => router.push("/login")} className="w-full">
            {t("goToSignIn")}
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          {error && (
            <div
              className="flex items-center gap-2 rounded-lg border border-status-high/20 bg-status-high/5 p-3 text-sm text-status-high"
              role="alert"
            >
              {error}
            </div>
          )}
          <Button onClick={handleConfirm} className="w-full" disabled={isLoading}>
            {isLoading ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" />
                {t("confirming")}
              </>
            ) : (
              <>
                <MailCheck className="mr-2 size-4" />
                {t("confirm")}
              </>
            )}
          </Button>
        </div>
      )}
    </CardContent>
  )
}

export default function ConfirmEmailChangePage() {
  const t = useTranslations()
  return (
    <div className="relative min-h-screen flex items-center justify-center bg-background px-4">
      <div className="absolute right-4 top-4 z-10">
        <LanguageSwitch />
      </div>
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl font-bold">{t("confirmEmailChange.title")}</CardTitle>
          <CardDescription>{t("confirmEmailChange.subtitle")}</CardDescription>
        </CardHeader>
        <Suspense
          fallback={
            <div className="min-h-24 flex items-center justify-center">{t("common.loading")}</div>
          }
        >
          <ConfirmEmailChangeForm />
        </Suspense>
      </Card>
    </div>
  )
}
