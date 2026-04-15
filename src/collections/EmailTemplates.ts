import type { CollectionConfig } from 'payload'

export const EmailTemplates: CollectionConfig = {
  slug: 'email-templates',
  admin: {
    useAsTitle: 'name',
    defaultColumns: ['name', 'key', 'updatedAt'],
    description: 'Транзакційні та кампанійні шаблони листів.',
  },
  fields: [
    {
      name: 'name',
      type: 'text',
      required: true,
      admin: {
        description: 'Зрозуміла назва, напр. "Вітальний лист" або "Виписка роялті"',
      },
    },
    {
      name: 'key',
      type: 'text',
      required: true,
      unique: true,
      admin: {
        description: 'Ідентифікатор для коду: "welcome", "royalty-statement", "low-stock-alert"',
      },
    },
    {
      name: 'subject',
      type: 'text',
      required: true,
      localized: true,
    },
    {
      name: 'preheader',
      type: 'text',
      localized: true,
      admin: {
        description: 'Короткий текст попереднього перегляду після теми',
      },
    },
    {
      name: 'body',
      type: 'richText',
      required: true,
      localized: true,
      admin: {
        description: 'Тіло листа. Використовуй {{variable_name}} для динамічних значень.',
      },
    },
    {
      name: 'variables',
      type: 'array',
      admin: {
        description: 'Доступні змінні шаблону з описами',
      },
      fields: [
        {
          name: 'key',
          type: 'text',
          required: true,
          admin: { description: 'напр. display_name' },
        },
        {
          name: 'description',
          type: 'text',
          admin: { description: "напр. Відображуване ім'я автора" },
        },
      ],
    },
    {
      name: 'isActive',
      type: 'checkbox',
      defaultValue: true,
      admin: {
        position: 'sidebar',
        description: 'Тільки активні шаблони використовуються email-service',
      },
    },
  ],
}
