// Settings page (Account & Data): profile, usage meters, data export,
// and the danger zone (change password / delete account).
export const settingsMessages = {
  en: {
    settings: {
      title: 'Account & Data',
      subtitle: 'Your profile, usage, and a portable copy of your health data.',
      anonymous: {
        title: 'Anonymous session',
        description:
          'You are using the app without an account. Your data lives only in this browser session. Register to keep it safe, get higher limits, and access it from any device.',
        registerCta: 'Create an account',
        sessionId: 'Session',
      },
      profile: {
        title: 'Profile',
        name: 'Name',
        email: 'Email',
        dob: 'Date of birth',
        gender: 'Gender',
      },
      usage: {
        title: 'Usage',
        extractions: 'AI document extractions',
        storage: 'Document storage',
        usedOf: '{used} of {total} used',
        limitReached: 'Limit reached',
      },
      data: {
        title: 'Your data',
        description:
          'Download a complete copy of your structured health data at any time. JSON is a full backup of everything; CSV is a spreadsheet-friendly table of all biomarker readings.',
        downloadJson: 'Download backup (JSON)',
        downloadCsv: 'Download readings (CSV)',
        downloading: 'Preparing…',
        downloadFailed: 'Download failed',
      },
      danger: {
        title: 'Danger zone',
        changePassword: 'Change password',
        currentPassword: 'Current password',
        newPassword: 'New password',
        confirmPassword: 'Confirm new password',
        save: 'Save new password',
        saving: 'Saving…',
        passwordMismatch: 'Passwords do not match',
        passwordTooShort: 'Password must be at least 8 characters',
        changeSuccess: 'Password changed.',
        changeFailed: 'Could not change the password.',
        deleteAccount: 'Delete account',
        deleteData: 'Delete all session data',
        deleteWarning:
          'Permanently deletes your account together with every entry, biomarker reading, and uploaded document. This cannot be undone.',
        deleteConfirmTitle: 'Delete account and all data?',
        deleteAnonConfirmTitle: 'Delete all session data?',
        deleteConfirmBody:
          'Every entry, biomarker reading, and uploaded document will be permanently removed. Download a backup first if you want to keep your data.',
        deleting: 'Deleting…',
        deleteFailed: 'Could not delete.',
        deleted: 'Your data has been permanently deleted.',
      },
    },
  },
  ru: {
    settings: {
      title: 'Аккаунт и данные',
      subtitle: 'Профиль, использование сервиса и переносимая копия ваших данных.',
      anonymous: {
        title: 'Анонимная сессия',
        description:
          'Вы используете приложение без аккаунта. Данные хранятся только в этой сессии браузера. Зарегистрируйтесь, чтобы сохранить их, получить повышенные лимиты и доступ с любого устройства.',
        registerCta: 'Создать аккаунт',
        sessionId: 'Сессия',
      },
      profile: {
        title: 'Профиль',
        name: 'Имя',
        email: 'Email',
        dob: 'Дата рождения',
        gender: 'Пол',
      },
      usage: {
        title: 'Использование',
        extractions: 'AI-распознавание документов',
        storage: 'Хранилище документов',
        usedOf: 'Использовано {used} из {total}',
        limitReached: 'Лимит достигнут',
      },
      data: {
        title: 'Ваши данные',
        description:
          'Скачайте полную копию своих структурированных данных о здоровье в любой момент. JSON — полная резервная копия; CSV — удобная таблица всех показателей для Excel.',
        downloadJson: 'Скачать резервную копию (JSON)',
        downloadCsv: 'Скачать показатели (CSV)',
        downloading: 'Подготовка…',
        downloadFailed: 'Не удалось скачать',
      },
      danger: {
        title: 'Опасная зона',
        changePassword: 'Сменить пароль',
        currentPassword: 'Текущий пароль',
        newPassword: 'Новый пароль',
        confirmPassword: 'Повторите новый пароль',
        save: 'Сохранить новый пароль',
        saving: 'Сохранение…',
        passwordMismatch: 'Пароли не совпадают',
        passwordTooShort: 'Пароль должен содержать не менее 8 символов',
        changeSuccess: 'Пароль изменён.',
        changeFailed: 'Не удалось изменить пароль.',
        deleteAccount: 'Удалить аккаунт',
        deleteData: 'Удалить все данные сессии',
        deleteWarning:
          'Безвозвратно удаляет ваш аккаунт вместе со всеми записями, показателями и загруженными документами. Это действие нельзя отменить.',
        deleteConfirmTitle: 'Удалить аккаунт и все данные?',
        deleteAnonConfirmTitle: 'Удалить все данные сессии?',
        deleteConfirmBody:
          'Все записи, показатели и загруженные документы будут безвозвратно удалены. Если данные нужны — сначала скачайте резервную копию.',
        deleting: 'Удаление…',
        deleteFailed: 'Не удалось удалить.',
        deleted: 'Ваши данные безвозвратно удалены.',
      },
    },
  },
} as const
