// Batch import (background extraction jobs), notifications bell, the
// /imports tracker page and the /review-import review page.
export const importMessages = {
  en: {
    import: {
      // ----- Batch mode on /add-entry -----
      batchTitle: 'Importing {count, plural, one {# document} other {# documents}}',
      batchSubtitle:
        'Extraction runs in the background — you are free to leave this page. Finished documents appear in the bell menu.',
      batchQuotaAnon:
        'You can import up to {limit} documents without an account — register to import more.',
      batchRemaining: '{count} of {limit} extractions left',
      batchRegisterToImport: 'Register to import',
      batchOverLimit:
        '{count, plural, one {# document exceeds} other {# documents exceed}} your remaining quota — {count, plural, one {it stays} other {they stay}} selected for after registration.',
      batchWaiting: 'Waiting',
      batchDone: 'Extracted',
      batchFailed: 'Failed',
      batchCancelled: 'Cancelled',
      batchEta: '≈ {seconds}s',
      batchOverall: '{done} of {total} ready',
      batchSubmitFailed: 'Couldn’t submit: {error}',
      batchReviewNow: 'Review now',
      batchTrackImports: 'Track remaining extractions',
      batchAllDone:
        '{count, plural, one {# document extracted — review it} other {# documents extracted — review them}}',
      batchLeaveHint: 'Nothing is lost by leaving — extraction continues on the server.',
      batchBack: 'Back to upload',
      batchCancel: 'Cancel',
      batchRetry: 'Retry',
      batchRemove: 'Remove',
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
      trackerActiveTitle: 'In progress',
      trackerHistoryTitle: 'Earlier imports',
      trackerSaved: 'Saved',
      trackerDismissed: 'Dismissed',
      batchOverLimitRegistered:
        'You have used all {limit} extractions — {count, plural, one {# document stays} other {# documents stay}} selected for later.',
      batchDismissed: 'Dismissed',
      trackerQueued: 'Waiting',
      trackerDone: 'Extracted',
      trackerFailed: 'Failed',
      trackerCancelled: 'Cancelled',
      // ----- Review page /review-import (B4) -----
      reviewTitle: 'Review extracted document',
      reviewLeaveForLater: 'Leave for later',
      reviewNextDocument: 'Next document',
      reviewSavedToast: 'Document saved',
      reviewMergedToast: 'Entries merged',
      reviewSameDateHint:
        'An entry already exists on this date — you can merge this document into it.',
      reviewGone:
        'This import is no longer available — it may have been saved, dismissed or expired.',
      reviewBack: 'Back to timeline',
      reviewLoadFailed: 'Couldn’t load the extracted document.',
      reviewLoading: 'Loading…',
    },
  },
  ru: {
    import: {
      // ----- Batch mode on /add-entry -----
      batchTitle: 'Импортируется {count, plural, one {# документ} few {# документа} many {# документов} other {# документа}}',
      batchSubtitle:
        'Распознавание идёт в фоне — со страницы можно уйти. Готовые документы появятся в колокольчике.',
      batchQuotaAnon:
        'Без аккаунта можно импортировать до {limit} документов — зарегистрируйтесь, чтобы импортировать больше.',
      batchRemaining: 'Осталось распознаваний: {count} из {limit}',
      batchRegisterToImport: 'Зарегистрироваться для импорта',
      batchOverLimit:
        '{count, plural, one {# документ превышает} few {# документа превышают} many {# документов превышают} other {# документа превышают}} оставшуюся квоту — {count, plural, one {он останется} few {они останутся} many {они останутся} other {они останутся}} выбранными после регистрации.',
      batchWaiting: 'Ожидает',
      batchDone: 'Распознано',
      batchFailed: 'Ошибка',
      batchCancelled: 'Отменено',
      batchEta: '≈ {seconds} с',
      batchOverall: 'Готово: {done} из {total}',
      batchSubmitFailed: 'Не удалось отправить: {error}',
      batchReviewNow: 'Проверить сейчас',
      batchTrackImports: 'Отслеживать остальные',
      batchAllDone:
        '{count, plural, one {# документ распознан — проверьте его} few {# документа распознаны — проверьте их} many {# документов распознано — проверьте их} other {# документа распознано — проверьте их}}',
      batchLeaveHint: 'Уходить не страшно — распознавание продолжается на сервере.',
      batchBack: 'Вернуться к загрузке',
      batchCancel: 'Отменить',
      batchRetry: 'Повторить',
      batchRemove: 'Убрать',
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
      trackerActiveTitle: 'В процессе',
      trackerHistoryTitle: 'Прошлые импорты',
      trackerSaved: 'Сохранён',
      trackerDismissed: 'Отклонён',
      batchOverLimitRegistered:
        'Вы использовали все {limit} распознаваний — {count, plural, one {# документ останется} few {# документа останутся} many {# документов останутся} other {# документа останутся}} выбранными на потом.',
      batchDismissed: 'Отклонено',
      trackerQueued: 'Ожидает',
      trackerDone: 'Распознано',
      trackerFailed: 'Ошибка',
      trackerCancelled: 'Отменено',
      // ----- Review page /review-import (B4) -----
      reviewTitle: 'Проверка распознанного документа',
      reviewLeaveForLater: 'Оставить на потом',
      reviewNextDocument: 'Следующий документ',
      reviewSavedToast: 'Документ сохранён',
      reviewMergedToast: 'Записи объединены',
      reviewSameDateHint:
        'На эту дату уже есть запись — можно объединить этот документ с ней.',
      reviewGone:
        'Этот импорт больше недоступен — возможно, он сохранён, удалён или истёк.',
      reviewBack: 'К хронологии',
      reviewLoadFailed: 'Не удалось загрузить распознанный документ.',
      reviewLoading: 'Загрузка…',
    },
  },
}
