<?php

namespace App\Service;

use Predis\Client;

class Redis {
	public const PREFIX = 'traffic:';

	public function __construct(
		private Client $client = new Client(['host' => 'redis']),
	) {}

	public function withPrefix(string $key): string {
		if (str_starts_with($key, Redis::PREFIX)) {
			return $key;
		}

		return Redis::PREFIX . $key;
	}

	public function get(string $key): mixed {
		$value = $this->client->get($this->withPrefix($key));
		return is_null($value) ? $value : json_decode($value, true);
	}

	public function set(string $key, mixed $value) {
		return $this->client->set($this->withPrefix($key), json_encode($value));
	}

	public function del(string $key) {
		return $this->client->del($this->withPrefix($key));
	}

	public function exists(string $key): bool {
		return $this->client->exists($this->withPrefix($key));
	}

	public function clear() {
		$client = $this->client;
		foreach ($this->keys('*') as $key) {
			if (str_starts_with($key, Redis::PREFIX)) {
				$client->del($key);
			}
		}
	}

	public function keys(string $pattern): array {
		return $this->client->keys($this->withPrefix($pattern));
	}
}
