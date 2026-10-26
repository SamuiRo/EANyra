# Приклади інстансу

Ця папка входить у Git і зберігає приклади налаштувань та контексту.
Особисті дані редагуються в `instance/`, а креденшали — у кореневому `.env`.

```text
instance_example/
  .env.example
  accounts.json.example
  context/
    voice.example.yaml
    bio.example.yaml
    platforms.example.yaml
    projects/
      _template.yaml
      eanyra.example.yaml
```

`npm run instance:init` створює відсутні робочі файли з цих прикладів, не
перезаписуючи наявні. `.env.example` копіюється в кореневий `.env`, приклади
голосу, біографії та правил — у `instance/context/` без суфікса `.example`.

`context/projects/eanyra.example.yaml` — збережений початковий приклад опису
проєкту. Він не створює реальний проєкт автоматично. Для власного проєкту
скопіюйте `_template.yaml` у `instance/context/projects/<slug>.yaml` та заповніть
перевірені дані. Після редагування виконайте `npm run context:sync`.

Не додавайте сюди справжні токени, cookies чи приватний контекст.
