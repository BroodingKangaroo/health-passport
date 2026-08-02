"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Loader2 } from "lucide-react"
import { signIn } from "next-auth/react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { fetchUsageLimits, fetchTimelineEvents } from "@/services/api"

export default function RegisterPage() {
  const router = useRouter()
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
      setError("Passwords do not match")
      return
    }
    
    if (formData.password.length < 8) {
      setError("Password must be at least 8 characters")
      return
    }

    setLoading(true)
    try {
      const API_URL = process.env.NEXT_PUBLIC_API_URL || ''
      const res = await fetch(`${API_URL}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          name: formData.name,
          email: formData.email,
          password: formData.password,
          dob: formData.dob,
          gender: formData.gender,
          migrate_data: migrateData,
        }),
      })

      const data = await res.json()
      
      if (!res.ok) {
        setError(data.detail || "Registration failed")
        return
      }

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

      toast.success("Account created!", {
        description: hasAnonData && migrateData
          ? "Your data has been transferred to your new account."
          : "Welcome to Health Passport.",
      })
      router.push("/")
      router.refresh()
    } catch {
      setError("An error occurred. Please try again.")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Create Account</CardTitle>
          <CardDescription>Start tracking your health journey</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="name" className="text-sm font-medium">
                Full Name
              </label>
              <Input
                id="name"
                name="name"
                type="text"
                value={formData.name}
                onChange={handleChange}
                required
                placeholder="Alexey Ivanov"
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="email" className="text-sm font-medium">
                Email
              </label>
              <Input
                id="email"
                name="email"
                type="email"
                value={formData.email}
                onChange={handleChange}
                required
                placeholder="alexey@example.com"
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="dob" className="text-sm font-medium">
                Date of Birth
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
                Gender
              </label>
              <select
                id="gender"
                name="gender"
                value={formData.gender}
                onChange={handleChange}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <option value="Male">Male</option>
                <option value="Female">Female</option>
                <option value="Other">Other</option>
              </select>
            </div>

            <div className="space-y-2">
              <label htmlFor="password" className="text-sm font-medium">
                Password
              </label>
              <Input
                id="password"
                name="password"
                type="password"
                value={formData.password}
                onChange={handleChange}
                required
                minLength={8}
                placeholder="At least 8 characters"
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="confirmPassword" className="text-sm font-medium">
                Confirm Password
              </label>
              <Input
                id="confirmPassword"
                name="confirmPassword"
                type="password"
                value={formData.confirmPassword}
                onChange={handleChange}
                required
                placeholder="Confirm your password"
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
                      Transfer my existing data
                    </label>
                    <p className="text-blue-700 mt-1">
                      We found data from your session. Check this to copy it to your new account.
                      Your anonymous data will also remain accessible if you log out.
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
                  Creating account...
                </>
              ) : (
                "Create Account"
              )}
            </Button>
          </form>

          <div className="mt-6 text-center text-sm text-muted-foreground">
            Already have an account?{" "}
            <Link href="/login" className="text-primary hover:underline font-medium">
              Sign in
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
