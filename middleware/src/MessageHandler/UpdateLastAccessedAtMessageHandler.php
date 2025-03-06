<?php

namespace App\MessageHandler;

use App\Message\UpdateLastAccessedAtMessage;
use App\Service\Redis;
use Symfony\Component\Messenger\Attribute\AsMessageHandler;

#[AsMessageHandler]
class UpdateLastAccessedAtMessageHandler {
	public function __invoke(
		UpdateLastAccessedAtMessage $message,
		Redis $redis,
	): void {
		$host = $message->host;

		if (!$host || !$redis->exists($host)) {
			return;
		}

		$project = $redis->get($host);
		$project['last_accessed_at'] = time();
		$redis->set($host, $project);
	}
}
