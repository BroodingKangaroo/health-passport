"use client"

import { Suspense, useState } from "react"
import { signIn } from "next-auth/react"
import { useRouter, useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import { Loader2, Mail, Lock, AlertCircle } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { LanguageSwitch } from "@/components/shared/language-switch"

function LoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const t = useTranslations("login")
  const callbackUrl = searchParams.get("callbackUrl") ?? "/"
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState("")

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setIsLoading(true)
    setError("")

    try {
      const res = await signIn("credentials", {
        email,
        password,
        redirect: false,
        callbackUrl,
      })

      if (res?.error) {
        setError(t("invalidCredentials"))
      } else {
        router.push(callbackUrl)
        router.refresh()
      }
    } catch {
      setError(t("unexpectedError"))
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="relative min-h-screen flex items-center justify-center bg-background px-4">
      <div className="absolute right-4 top-4 z-10">
        <LanguageSwitch />
      </div>
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl font-bold">{t("title")}</CardTitle>
          <CardDescription>{t("subtitle")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="flex items-center gap-2 rounded-lg border border-status-high/20 bg-status-high/5 p-3 text-sm text-status-high">
                <AlertCircle className="size-4 shrink-0" />
                {error}
              </div>
            )}

            <div className="space-y-2">
              <label htmlFor="email" className="block text-sm font-medium mb-1">
                {t("email")}
              </label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="email"
                  type="email"
                  placeholder={t("emailPlaceholder")}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="pl-10"
                  required
                  disabled={isLoading}
                />
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label htmlFor="password" className="block text-sm font-medium mb-1">
                  {t("password")}
                </label>
                <a href="/forgot-password" className="text-sm text-primary hover:underline">
                  {t("forgotPassword")}
                </a>
              </div>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="password"
                  type="password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="pl-10"
                  required
                  disabled={isLoading}
                />
              </div>
            </div>

            <Button type="submit" className="w-full" disabled={isLoading}>
              {isLoading ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  {t("signingIn")}
                </>
              ) : (
                t("signIn")
              )}
            </Button>
          </form>

          <div className="mt-6 text-center text-sm text-muted-foreground">
            {t("noAccount")}{" "}
            <a href="/register" className="text-primary hover:underline font-medium">
              {t("signUp")}
            </a>
          </div>
        </CardContent>
        {process.env.NEXT_PUBLIC_DEMO_CREDENTIALS && (
          <div className="flex justify-center text-xs text-muted-foreground pt-4">
            {t("demo", { credentials: process.env.NEXT_PUBLIC_DEMO_CREDENTIALS })}
          </div>
        )}
      </Card>
    </div>
  )
}

export default function LoginPage() {
  const t = useTranslations()
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center">{t("common.loading")}</div>}>
      <LoginForm />
    </Suspense>
  )
}