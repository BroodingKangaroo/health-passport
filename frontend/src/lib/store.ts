import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface Toast {
  id: string
  type: 'success' | 'error' | 'info' | 'warning'
  message: string
  description?: string
}

interface UIState {
  // Sidebar
  sidebarOpen: boolean
  toggleSidebar: () => void
  setSidebarOpen: (open: boolean) => void

  // Toasts
  toasts: Toast[]
  addToast: (toast: Omit<Toast, 'id'>) => void
  removeToast: (id: string) => void

  // Modal
  modalOpen: boolean
  modalContent: React.ReactNode | null
  openModal: (content: React.ReactNode) => void
  closeModal: () => void

  // Loading states
  globalLoading: boolean
  setGlobalLoading: (loading: boolean) => void
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      sidebarOpen: true,
      toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
      setSidebarOpen: (open) => set({ sidebarOpen: open }),

      toasts: [],
      addToast: (toast) =>
        set((state) => ({
          toasts: [...state.toasts, { ...toast, id: Math.random().toString(36).slice(2) }],
        })),
      removeToast: (id) =>
        set((state) => ({
          toasts: state.toasts.filter((t) => t.id !== id),
        })),

      modalOpen: false,
      modalContent: null,
      openModal: (content) => set({ modalOpen: true, modalContent: content }),
      closeModal: () => set({ modalOpen: false, modalContent: null }),

      globalLoading: false,
      setGlobalLoading: (loading) => set({ globalLoading: loading }),
    }),
    {
      name: 'health-passport-ui',
      partialize: (state) => ({ sidebarOpen: state.sidebarOpen }),
    }
  )
)