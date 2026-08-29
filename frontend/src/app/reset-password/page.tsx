"use client"

import { Suspense, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import Link from "next/link"
import { useTranslations } from "next-intl"
import { Loader2, Lock, ArrowLeft } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { LanguageSwitch } from "@/components/shared/language-switch"

function ResetPasswordForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const t = useTranslations("resetPassword")
  const token = searchParams.get("token") ?? ""
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState("")
  const [done, setDone] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError("")

    if (password !== confirmPassword) {
      setError(t("passwordMismatch"))
      return
    }

    if (password.length < 8) {
      setError(t("passwordTooShort"))
      return
    }

    setIsLoading(true)
    try {
      const API_URL = process.env.NEXT_PUBLIC_API_URL || ""
      const res = await fetch(`${API_URL}/api/auth/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ token, new_password: password }),
      })

      const data = await res.json()

      if (!res.ok) {
        setError(data.detail || t("unexpectedError"))
        return
      }

      setDone(true)
    } catch {
      setError(t("unexpectedError"))
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
            href="/forgot-password"
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
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div
              className="flex items-center gap-2 rounded-lg border border-status-high/20 bg-status-high/5 p-3 text-sm text-status-high"
              role="alert"
            >
              {error}
            </div>
          )}

          <div className="space-y-2">
            <label htmlFor="password" className="block text-sm font-medium mb-1">
              {t("newPassword")}
            </label>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="password"
                type="password"
                placeholder={t("newPasswordPlaceholder")}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="pl-10"
                required
                minLength={8}
                disabled={isLoading}
              />
            </div>
          </div>

          <div className="space-y-2">
            <label htmlFor="confirmPassword" className="block text-sm font-medium mb-1">
              {t("confirmNewPassword")}
            </label>
            <Input
              id="confirmPassword"
              type="password"
              placeholder={t("confirmNewPasswordPlaceholder")}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              disabled={isLoading}
            />
          </div>

          <Button type="submit" className="w-full" disabled={isLoading}>
            {isLoading ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" />
                {t("updating")}
              </>
            ) : (
              t("submit")
            )}
          </Button>
        </form>
      )}
    </CardContent>
  )
}

export default function ResetPasswordPage() {
  const t = useTranslations()
  return (
    <div className="relative min-h-screen flex items-center justify-center bg-background px-4">
      <div className="absolute right-4 top-4 z-10">
        <LanguageSwitch />
      </div>
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl font-bold">{t("resetPassword.title")}</CardTitle>
          <CardDescription>{t("resetPassword.subtitle")}</CardDescription>
        </CardHeader>
        <Suspense fallback={<div className="min-h-24 flex items-center justify-center">{t("common.loading")}</div>}>
          <ResetPasswordForm />
        </Suspense>
      </Card>
    </div>
  )
}
