# UKL Route Network

Статична інтерактивна карта регулярних рейсів Ukraine Classic Air Alliance. Сайт не потребує сервера, бази даних або збірки й підходить для GitHub Pages.

## Публікація на GitHub Pages

1. Створіть новий репозиторій GitHub.
2. Завантажте **вміст цієї папки** в корінь гілки `main`.
3. Відкрийте `Settings → Pages`.
4. У `Build and deployment` виберіть `Deploy from a branch`, гілку `main` і папку `/ (root)`.
5. Збережіть налаштування — GitHub покаже адресу сайту після публікації.

Усі внутрішні шляхи відносні, тому сайт працює і на адресі виду `username.github.io/repository/`.

## Оновлення розкладу

Замініть `data/schedules.csv` новим експортом Newsky з тією самою структурою колонок. Якщо в новому файлі з'являться нові ICAO-коди, для них також потрібно додати координати до `data/airports.json`.

Для локального перегляду відкривайте папку через локальний HTTP-сервер: браузери зазвичай блокують завантаження CSV при відкритті `index.html` напряму через `file://`.

## Дані та бібліотеки

- Координати й назви аеропортів: [OurAirports](https://ourairports.com/data/), public domain.
- Карта: [Leaflet 1.9.4](https://leafletjs.com/), BSD-2-Clause.
- Підкладка карти: CARTO Dark Matter, дані OpenStreetMap.
