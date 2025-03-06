<?php

namespace App\Message;

class UpdateLastAccessedAtMessage {
	public function __construct(
		public readonly string $host
	) {}
}
