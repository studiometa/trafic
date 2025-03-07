<?php

namespace App\MessageHandler;

use App\Message\UpdateLastAccessedAtMessage;
use App\Service\Redis;
use Symfony\Component\Messenger\Attribute\AsMessageHandler;

#[AsMessageHandler]
class UpdateLastAccessedAtMessageHandler {
	public function __construct(
		private readonly Redis $redis,
	) {}

	public function __invoke(
		UpdateLastAccessedAtMessage $message,
	): void {
		$host = $message->host;

		if (!$host || !$this->redis->exists($host)) {
			return;
		}

		$project = $this->redis->get($host);
		$project['last_accessed_at'] = time();
		$this->redis->set($host, $project);
	}
}
