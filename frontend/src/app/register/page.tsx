"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Loader2 } from "lucide-react"
import { signIn } from "next-auth/react"
import { toast } from "sonner"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { LanguageSwitch } from "@/components/shared/language-switch"
import { fetchUsageLimits, fetchTimelineEvents, registerUser } from "@/services/api"

export default function RegisterPage() {
  const router = useRouter()
  const t = useTranslations("register")
  const [formData, setFormData] = useState({
    name: "",
    email: "",
    password: "",
    confirmPassword: "",
    dob: "",
    gender: "Male",
  })
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const [hasAnonData, setHasAnonData] = useState(false)
  const [migrateData, setMigrateData] = useState(true)

  // Check if user has anonymous data
  useEffect(() => {
    Promise.all([
      fetchUsageLimits().catch(() => null),
      fetchTimelineEvents().catch(() => null),
    ]).then(([limits, timeline]) => {
      if (!limits || !timeline) return
      if ((timeline.events && timeline.events.length > 0) ||
          limits.ai_extraction_count > 0 ||
          limits.total_upload_size_bytes > 0) {
        setHasAnonData(true)
      }
    })
  }, [])

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setFormData((prev) => ({ ...prev, [e.target.name]: e.target.value }))
    setError("")
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError("")
    
    if (formData.password !== formData.confirmPassword) {
      setError(t("passwordMismatch"))
      return
    }

    if (formData.password.length < 8) {
      setError(t("passwordTooShort"))
      return
    }

    setLoading(true)
    try {
      // Through the shared api layer (ISSUES.md #62): localized backend
      // errors + 422 validation arrays rendered as readable text.
      await registerUser({
        name: formData.name,
        email: formData.email,
        password: formData.password,
        dob: formData.dob,
        gender: formData.gender,
        migrate_data: migrateData,
      })

      // Auto-login after registration via next-auth so the session/JWT is established.
      const result = await signIn("credentials", {
        email: formData.email,
        password: formData.password,
        redirect: false,
      })

      if (result?.error) {
        // Registration succeeded but auto-login failed — send to /login.
        router.push("/login")
        return
      }

      toast.success(t("toast.title"), {
        description: hasAnonData && migrateData
          ? t("toast.dataTransferred")
          : t("toast.welcome"),
      })
      router.push("/")
      router.refresh()
    } catch (err) {
      // registerUser throws ApiError with an already-readable message
      // (localized backend detail or a 422 validation summary).
      setError(err instanceof Error ? err.message : t("unexpectedError"))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <div className="absolute right-4 top-4 z-10">
        <LanguageSwitch />
      </div>
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">{t("title")}</CardTitle>
          <CardDescription>{t("subtitle")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="name" className="text-sm font-medium">
                {t("fullName")}
              </label>
              <Input
                id="name"
                name="name"
                type="text"
                value={formData.name}
                onChange={handleChange}
                required
                placeholder={t("fullNamePlaceholder")}
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="email" className="text-sm font-medium">
                {t("email")}
              </label>
              <Input
                id="email"
                name="email"
                type="email"
                value={formData.email}
                onChange={handleChange}
                required
                placeholder={t("emailPlaceholder")}
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="dob" className="text-sm font-medium">
                {t("dateOfBirth")}
              </label>
              <Input
                id="dob"
                name="dob"
                type="date"
                value={formData.dob}
                onChange={handleChange}
                required
                max={new Date().toISOString().split("T")[0]}
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="gender" className="text-sm font-medium">
                {t("gender")}
              </label>
              <select
                id="gender"
                name="gender"
                value={formData.gender}
                onChange={handleChange}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <option value="Male">{t("genderMale")}</option>
                <option value="Female">{t("genderFemale")}</option>
                <option value="Other">{t("genderOther")}</option>
              </select>
            </div>

            <div className="space-y-2">
              <label htmlFor="password" className="text-sm font-medium">
                {t("password")}
              </label>
              <Input
                id="password"
                name="password"
                type="password"
                value={formData.password}
                onChange={handleChange}
                required
                minLength={8}
                placeholder={t("passwordPlaceholder")}
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="confirmPassword" className="text-sm font-medium">
                {t("confirmPassword")}
              </label>
              <Input
                id="confirmPassword"
                name="confirmPassword"
                type="password"
                value={formData.confirmPassword}
                onChange={handleChange}
                required
                placeholder={t("confirmPasswordPlaceholder")}
              />
            </div>

            {hasAnonData && (
              <div className="rounded-md bg-blue-50 p-3 border border-blue-200">
                <div className="flex items-start">
                  <input
                    id="migrate_data"
                    name="migrate_data"
                    type="checkbox"
                    checked={migrateData}
                    onChange={(e) => setMigrateData(e.target.checked)}
                    className="h-4 w-4 mt-0.5 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                  />
                  <div className="ml-3 text-sm">
                    <label htmlFor="migrate_data" className="font-medium text-blue-900">
                      {t("migration.title")}
                    </label>
                    <p className="text-blue-700 mt-1">
                      {t("migration.description")}
                    </p>
                  </div>
                </div>
              </div>
            )}

            {error && (
              <div className="text-sm text-red-500" role="alert">
                {error}
              </div>
            )}

            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  {t("creatingAccount")}
                </>
              ) : (
                t("submit")
              )}
            </Button>
          </form>

          <div className="mt-6 text-center text-sm text-muted-foreground">
            {t("haveAccount")}{" "}
            <Link href="/login" className="text-primary hover:underline font-medium">
              {t("signIn")}
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
