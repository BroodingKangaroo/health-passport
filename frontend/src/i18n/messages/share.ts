// Sender-side copy for the shareable link (create, copy, revoke).
// Kept separate from `sharedView` (the recipient's copy) so the two audiences
// can never drift into each other's wording.
export const shareMessages = {
  en: {
    share: {
      button: 'Share a link',
      dialog: {
        title: 'Share this record',
        body: 'Anyone with this link can view your record until it expires. You can revoke it at any time. The link always shows your record as it is now.',
        warning:
          'Anyone who has the link can open it, including anyone it gets forwarded to. It stops working on the expiry date or as soon as you revoke it.',
        create: 'Create link',
        creating: 'Creating link...',
        copy: 'Copy link',
        copied: 'Copied',
        close: 'Close',
        expires: 'Expires {date}',
        error: 'Could not create the link. Try again.',
      },
      links: {
        title: 'Your links',
        empty: 'You have not shared this record yet.',
        active: 'Active',
        expired: 'Expired {date}',
        revoked: 'Revoked {date}',
        created: 'Created {date}',
        expires: 'Expires {date}',
        opened: 'First opened {date}',
        neverOpened: 'Not opened yet',
        revoke: 'Revoke',
        revokeAll: 'Revoke all',
        loadError: 'Could not load your links.',
      },
    },
  },
  ru: {
    share: {
      button: 'Поделиться ссылкой',
      dialog: {
        title: 'Поделиться этой картой',
        body: 'Любой, у кого есть эта ссылка, увидит вашу карту, пока не истечёт её срок. Отозвать ссылку можно в любой момент. По ссылке всегда видна текущая версия карты.',
        warning:
          'Ссылку сможет открыть любой, кому она попадёт в руки, в том числе при пересылке. Она перестанет работать в день истечения срока или сразу после отзыва.',
        create: 'Создать ссылку',
        creating: 'Создание ссылки...',
        copy: 'Скопировать ссылку',
        copied: 'Скопировано',
        close: 'Закрыть',
        expires: 'Действует до {date}',
        error: 'Не удалось создать ссылку. Попробуйте ещё раз.',
      },
      links: {
        title: 'Ваши ссылки',
        empty: 'Вы ещё не делились этой картой.',
        active: 'Активна',
        expired: 'Истекла {date}',
        revoked: 'Отозвана {date}',
        created: 'Создана {date}',
        expires: 'Действует до {date}',
        opened: 'Первое открытие {date}',
        neverOpened: 'Ещё не открывали',
        revoke: 'Отозвать',
        revokeAll: 'Отозвать все',
        loadError: 'Не удалось загрузить ваши ссылки.',
      },
    },
  },
}
