FROM webdevops/php-nginx:8.3

WORKDIR /app
COPY composer.json .
COPY composer.lock .
RUN composer install --no-dev --optimize-autoloader --prefer-dist
RUN chown -R application:application /app
ENV APP_ENV=dev
