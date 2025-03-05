FROM webdevops/php:8.3 as deps

COPY composer.json /
COPY composer.lock /
RUN composer install --no-dev --optimize-autoloader --prefer-dist

FROM webdevops/php-apache:8.3

WORKDIR /app
COPY --from=deps /vendor /app/vendor
COPY . .
ENV APP_ENV=prod

# Sync project list every 5th minute
RUN docker-cronjob '*/5 * * * * php /cli/sync.php'

# Stop stale projects every hour
RUN docker-cronjob '33 * * * * php /cli/stop.php'

# USER application
# COPY ./root/.ssh /home/application/.ssh
