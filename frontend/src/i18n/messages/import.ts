// Batch import (background extraction jobs), notifications bell, the
// /imports tracker page and the /review-import review page.
export const importMessages = {
  en: {
    import: {
      // ----- Batch submission on /add-entry (headless, then redirect) -----
      batchSubmitting:
        'Submitting {count, plural, one {# document} other {# documents}}…',
      batchSubmittingHint: 'You will be taken to the imports page.',
      batchSkippedOverQuota:
        '{count, plural, one {# document wasn’t submitted — extraction limit reached.} other {# documents weren’t submitted — extraction limit reached.}}',
      batchLimitsUnavailable:
        'Couldn’t check your extraction quota — please try again.',
      batchSubmitFailed: 'Couldn’t submit: {error}',
      batchEta: '≈ {seconds}s',
      batchBack: 'Back to upload',
      // ----- Notifications bell (B2) -----
      bellLabel: 'Notifications',
      bellEmpty: 'No notifications',
      bellViewAll: 'View all imports',
      bellMarkAllRead: 'Mark all read',
      bellDoneTitle: 'Document extracted',
      bellDoneAction: 'Review',
      bellFailedTitle: 'Extraction failed',
      bellFailedAction: 'Retry',
      bellDismiss: 'Dismiss',
      bellToastSingle: '{filename} extracted — ready for review',
      bellToastMany: '{count, plural, one {# document extracted} other {# documents extracted}} — review',
      // ----- Tracker page /imports (B3) -----
      trackerTitle: 'Imports',
      trackerSubtitle: 'Live status of every document you are importing.',
      trackerEmpty: 'No documents in progress — import one.',
      trackerImportOne: 'Import a document',
      trackerCancel: 'Cancel',
      trackerRetry: 'Retry',
      trackerDismiss: 'Dismiss',
      trackerReview: 'Review',
      trackerNew: 'New',
      trackerActiveTitle: 'In progress',
      trackerHistoryTitle: 'Earlier imports',
      trackerShowHistory: 'Show earlier imports ({count})',
      trackerRestore: 'Restore',
      trackerRestoredToast: 'Import restored — ready for review',
      trackerRestoreFailed: 'Couldn’t restore the import — it may have expired.',
      trackerSaved: 'Saved',
      trackerDismissed: 'Dismissed',
      trackerQueued: 'Waiting',
      trackerDone: 'Extracted',
      trackerFailed: 'Failed',
      trackerCancelled: 'Cancelled',
      // ----- Review page /review-import (B4) -----
      reviewTitle: 'Review extracted document',
      reviewLeaveForLater: 'Leave for later',
      reviewNextDocument: 'Next document',
      reviewSavedToast: 'Document saved',
      reviewDismissToast: 'Document dismissed',
      reviewMergedToast: 'Entries merged',
      reviewSameDateHint:
        'An entry already exists on this date — you can merge this document into it.',
      reviewGone:
        'This import is no longer available — it may have been saved, dismissed or expired.',
      reviewBack: 'Back to timeline',
      reviewLoadFailed: 'Couldn’t load the extracted document.',
      reviewLoading: 'Loading…',
      mergeOverlapWarning:
        'Overlaps {count, plural, one {# existing biomarker} other {# existing biomarkers}} — merging will be blocked',
    },
  },
  ru: {
    import: {
      // ----- Batch submission on /add-entry (headless, then redirect) -----
      batchSubmitting:
        'Отправка {count, plural, one {# документа} few {# документов} many {# документов} other {# документов}}…',
      batchSubmittingHint: 'Сейчас откроется страница импортов.',
      batchSkippedOverQuota:
        '{count, plural, one {# документ не отправлен — достигнут лимит распознаваний.} few {# документа не отправлено — достигнут лимит распознаваний.} many {# документов не отправлено — достигнут лимит распознаваний.} other {# документа не отправлено — достигнут лимит распознаваний.}}',
      batchLimitsUnavailable:
        'Не удалось проверить квоту распознаваний — попробуйте ещё раз.',
      batchSubmitFailed: 'Не удалось отправить: {error}',
      batchEta: '≈ {seconds} с',
      batchBack: 'Вернуться к загрузке',
      // ----- Notifications bell (B2) -----
      bellLabel: 'Уведомления',
      bellEmpty: 'Нет уведомлений',
      bellViewAll: 'Все импорты',
      bellMarkAllRead: 'Отметить всё прочитанным',
      bellDoneTitle: 'Документ распознан',
      bellDoneAction: 'Проверить',
      bellFailedTitle: 'Ошибка распознавания',
      bellFailedAction: 'Повторить',
      bellDismiss: 'Убрать',
      bellToastSingle: '{filename} распознан — готов к проверке',
      bellToastMany: '{count, plural, one {# документ распознан} few {# документа распознаны} many {# документов распознано} other {# документа распознано}} — проверьте',
      // ----- Tracker page /imports (B3) -----
      trackerTitle: 'Импорты',
      trackerSubtitle: 'Статус каждого документа в процессе импорта.',
      trackerEmpty: 'Нет документов в процессе — импортируйте первый.',
      trackerImportOne: 'Импортировать документ',
      trackerCancel: 'Отменить',
      trackerRetry: 'Повторить',
      trackerDismiss: 'Убрать',
      trackerReview: 'Проверить',
      trackerNew: 'Новый',
      trackerActiveTitle: 'В процессе',
      trackerHistoryTitle: 'Прошлые импорты',
      trackerShowHistory: 'Показать прошлые импорты ({count})',
      trackerRestore: 'Восстановить',
      trackerRestoredToast: 'Импорт восстановлен — готов к проверке',
      trackerRestoreFailed: 'Не удалось восстановить импорт — возможно, срок его действия истёк.',
      trackerSaved: 'Сохранён',
      trackerDismissed: 'Отклонён',
      trackerQueued: 'Ожидает',
      trackerDone: 'Распознано',
      trackerFailed: 'Ошибка',
      trackerCancelled: 'Отменено',
      // ----- Review page /review-import (B4) -----
      reviewTitle: 'Проверка распознанного документа',
      reviewLeaveForLater: 'Оставить на потом',
      reviewNextDocument: 'Следующий документ',
      reviewSavedToast: 'Документ сохранён',
      reviewDismissToast: 'Документ отклонён',
      reviewMergedToast: 'Записи объединены',
      reviewSameDateHint:
        'На эту дату уже есть запись — можно объединить этот документ с ней.',
      reviewGone:
        'Этот импорт больше недоступен — возможно, он сохранён, удалён или истёк.',
      reviewBack: 'К хронологии',
      reviewLoadFailed: 'Не удалось загрузить распознанный документ.',
      reviewLoading: 'Загрузка…',
      mergeOverlapWarning:
        'Пересекается с существующей записью: {count, plural, one {# биомаркер} few {# биомаркера} many {# биомаркеров} other {# биомаркера}} — объединение будет недоступно',
    },
  },
}
