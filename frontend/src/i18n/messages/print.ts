// Print setup, translation review dialog, and print-editor sidebar chrome.
// (The printed document itself has its own per-document-language maps inside
// print-editor.tsx — those are NOT part of the UI localization.)
export const printMessages = {
  en: {
    print: {
      setup: {
        title: 'Prepare Document for Print/Export',
        subtitle: 'AI translation of medical terminology may take a few moments.',
        translationMode: 'Translation Mode',
        modes: {
          original: {
            title: 'Keep Original',
            desc: 'Export names exactly as they appear in your documents — fastest export.',
          },
          translate: {
            title: 'Translate to…',
            desc: 'Convert all terminology into a single language.',
          },
          bilingual: {
            title: 'Bilingual Format',
            desc: 'Show the original alongside the target language.',
          },
        },
        targetLangs: {
          en: 'English',
          de: 'German',
          fr: 'French',
          es: 'Spanish',
          he: 'Hebrew',
          pl: 'Polish',
        },
        cachedNotice: 'Already translated — regenerated instantly at no AI cost.',
        translating: 'Translating terminology… {elapsed}s',
        generate: 'Generate Document',
        leaveGuard:
          'AI translation is in progress. If you leave now, the translation will be cancelled and no names will be translated.',
        toastFailed:
          'AI translation failed ({reason}). The document is shown in English / your source language — switch the mode back to “Original” or regenerate to retry.',
        toastSaved:
          'Saved {count, plural, one {# translation} other {# translations}} for future documents.',
        toastSaveFailed:
          'Could not save translations ({reason}) — this document will use English for them.',
      },
      review: {
        title: 'Verify Translations',
        intro:
          'AI-translated terminology for the {languageLabel} document. Switch a term to English to use its original name. Accepted terms are saved and reused in future documents; going back discards them.',
        biomarker: 'Biomarker',
        nameInDocument: 'Name used in document',
        badges: {
          cached: 'already translated',
          fallback: 'English fallback',
          keptAsIs: 'kept as-is',
        },
        keptAsIsTooltip:
          'Returned unchanged — Latin term, acronym, or proper noun that stays identical in this language.',
        fallbackTooltip: 'The AI could not translate this name.',
        radioName: 'Name used in document for {name}',
        radioTranslation: 'Use translation for {name}',
        radioEnglish: 'Use English for {name}',
        translation: 'Translation',
        english: 'English',
        panelHeadings: 'Panel headings (applied automatically)',
        legendKeptAsIs: '— Latin term, acronym, or proper noun that stays identical.',
        legendFallback: '— the AI could not translate this name.',
        choiceNote:
          'Choosing a name here never removes the biomarker from the document — to leave biomarkers out entirely, use the filter in the print editor.',
        back: 'Back — discard translations',
        saveAndGenerate: 'Save {count, plural, other {#}} & Generate Document',
        generateNothingSaved: 'Generate Document (nothing saved)',
        fallbackWarning:
          '{count, plural, one {# name} other {# names}} could not be translated and will appear in English.',
      },
      editor: {
        backToSetup: '← Back to Setup',
        documentEditor: 'Document Editor',
        formatting: 'Formatting & Layout',
        orientation: 'Orientation',
        portrait: 'portrait',
        landscape: 'landscape',
        textSize: 'Text Size',
        textSizeAria: 'Text size',
        columns: 'Columns (Dates)',
        last3: 'Last 3',
        last5: 'Last 5',
        last10: 'Last 10',
        all: 'All',
        rows: 'Rows (Biomarkers)',
        showAbnormalOnly: 'Show Abnormal Only',
        hidesNormal: 'Hides all normal results',
        showReferences: 'Show Reference Ranges',
        referenceHint: 'Display reference range below each biomarker',
        compactNumbers: 'Compact Large Numbers',
        compactHint: 'Show 10M, 1B instead of 10,000,000',
        print: 'Print Document',
        emptyDates: 'Select at least one date column.',
        emptyBiomarkers: 'No biomarkers match your filters.',
        showBiomarker: 'Show {name}',
      },
      view: {
        backToDashboard: 'Back to Dashboard',
      },
      editorView: {
        loading: 'Loading flowsheet data…',
        failedToLoad: 'Failed to load data.',
      },
    },
  },
  ru: {
    print: {
      setup: {
        title: 'Подготовка документа к печати и экспорту',
        subtitle: 'Перевод медицинской терминологии с помощью ИИ может занять некоторое время.',
        translationMode: 'Режим перевода',
        modes: {
          original: {
            title: 'Оставить оригинал',
            desc: 'Экспортировать названия в точности как в ваших документах — самый быстрый вариант.',
          },
          translate: {
            title: 'Перевести на…',
            desc: 'Перевести всю терминологию на один язык.',
          },
          bilingual: {
            title: 'Двуязычный формат',
            desc: 'Показывать оригинал рядом с переводом.',
          },
        },
        targetLangs: {
          en: 'Английский',
          de: 'Немецкий',
          fr: 'Французский',
          es: 'Испанский',
          he: 'Иврит',
          pl: 'Польский',
        },
        cachedNotice: 'Уже переведено — документ собран мгновенно и без затрат на ИИ.',
        translating: 'Переводим терминологию… {elapsed} с',
        generate: 'Создать документ',
        leaveGuard:
          'Идёт ИИ-перевод. Если уйти сейчас, перевод будет отменён и названия останутся непереведёнными.',
        toastFailed:
          'Не удалось выполнить ИИ-перевод ({reason}). Документ показан на английском / исходном языке — переключитесь на режим «Оставить оригинал» или повторите попытку.',
        toastSaved:
          '{count, plural, one {Сохранён # перевод для будущих документов.} few {Сохранено # перевода для будущих документов.} many {Сохранено # переводов для будущих документов.} other {Сохранено # перевода для будущих документов.}}',
        toastSaveFailed:
          'Не удалось сохранить переводы ({reason}) — в этом документе для них будет использован английский.',
      },
      review: {
        title: 'Проверка переводов',
        intro:
          'Язык документа: {languageLabel}. Терминология переведена с помощью ИИ. Переключите термин на английский, чтобы использовать исходное название. Принятые термины сохраняются и переиспользуются в будущих документах; при возврате они отбрасываются.',
        biomarker: 'Показатель',
        nameInDocument: 'Название в документе',
        badges: {
          cached: 'уже переведено',
          fallback: 'оставлено на английском',
          keptAsIs: 'оставлено как есть',
        },
        keptAsIsTooltip:
          'Возвращено без изменений — латинский термин, аббревиатура или имя собственное, которое на этом языке остаётся прежним.',
        fallbackTooltip: 'ИИ не смог перевести это название.',
        radioName: 'Название в документе для {name}',
        radioTranslation: 'Использовать перевод для {name}',
        radioEnglish: 'Использовать английский для {name}',
        translation: 'Перевод',
        english: 'Английский',
        panelHeadings: 'Заголовки панелей (применяются автоматически)',
        legendKeptAsIs: '— латинский термин, аббревиатура или имя собственное, которое остаётся прежним.',
        legendFallback: '— ИИ не смог перевести это название.',
        choiceNote:
          'Выбор названия здесь никогда не убирает показатель из документа — чтобы полностью исключить показатели, используйте фильтр в редакторе печати.',
        back: 'Назад — отменить переводы',
        saveAndGenerate:
          'Сохранить {count, plural, one {# перевод} few {# перевода} many {# переводов} other {# перевода}} и создать документ',
        generateNothingSaved: 'Создать документ (ничего не сохранено)',
        fallbackWarning:
          'Не удалось перевести {count, plural, one {# название — оно появится} few {# названия — они появятся} many {# названий — они появятся} other {# названия — они появятся}} в документе на английском.',
      },
      editor: {
        backToSetup: '← Назад к настройкам',
        documentEditor: 'Редактор документа',
        formatting: 'Форматирование и компоновка',
        orientation: 'Ориентация',
        portrait: 'книжная',
        landscape: 'альбомная',
        textSize: 'Размер текста',
        textSizeAria: 'Размер текста',
        columns: 'Столбцы (даты)',
        last3: 'Последние 3',
        last5: 'Последние 5',
        last10: 'Последние 10',
        all: 'Все',
        rows: 'Строки (показатели)',
        showAbnormalOnly: 'Показывать только отклонения',
        hidesNormal: 'Скрывает все результаты в норме',
        showReferences: 'Показывать референсные диапазоны',
        referenceHint: 'Отображать референсный диапазон под каждым показателем',
        compactNumbers: 'Компактные большие числа',
        compactHint: 'Показывать 10 млн, 1 млрд вместо 10 000 000',
        print: 'Печать документа',
        emptyDates: 'Выберите хотя бы один столбец с датой.',
        emptyBiomarkers: 'Ни один показатель не подходит под фильтры.',
        showBiomarker: 'Показать {name}',
      },
      view: {
        backToDashboard: 'Назад на главную',
      },
      editorView: {
        loading: 'Загрузка данных листа…',
        failedToLoad: 'Не удалось загрузить данные.',
      },
    },
  },
} as const
