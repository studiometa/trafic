<?php

namespace App\Controller;

use App\Service\DDEV;
use App\Service\Redis;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Routing\Attribute\Route;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use App\Message\MaybeStartProjectMessage;
use App\Message\UpdateLastAccessedAtMessage;
use Symfony\Component\Messenger\MessageBusInterface;

class AuthController extends AbstractController
{
    #[Route('/__auth__', name: 'auth')]
    public function index(
      Request $request,
      Redis $redis,
      MessageBusInterface $messageBus,
    ): Response
    {
        $host = $request->headers->get('x-forwarded-host');

        // Try to start the project as early as possible in order
        // to wait the least amount of time on the loading screen.
        $messageBus->dispatch(new MaybeStartProjectMessage($host));

        // Available auth methods: IP, token or basic auth.
        $ip = $request->headers->get('cf-connecting-ip')
          ?? $request->headers->get('x-real-ip')
          ?? $request->headers->get('x-forwarded-for')
          ?? $request->server->get('REMOTE_ADDR')
          ?? null;

        $token       = $request->headers->get('x-trafic-auth-token');
        $subdomain   = $host ? current(explode('.', $host)) : null;
        $user        = $request->headers->get('php-auth-user');
        $password    = $request->headers->get('php-auth-pw');
        $config_path = dirname(__DIR__, 2) . '/auth.config.php';

        if (!file_exists($config_path)) {
          return new Response('missing auth.config.php configuration file', 409);
        }

        // Get configured credentials.
        $config             = require($config_path);
        $allowed_ips        = $config['ips'];
        $allowed_tokens     = $config['tokens'];
        $allowed_subdomains = $config['subdomains'];
        $allowed_users      = $config['users'];

        $is_allowed = false;

        // IP detection
        if (in_array($ip, $allowed_ips)) {
          $is_allowed = true;
        }

        // Authorize local IPs
        if (str_starts_with($ip, '127.0.') || str_starts_with($ip, '192.168.')) {
          $is_allowed = true;
        }

        // Header token detection
        if ($token && in_array($token, $allowed_tokens)) {
          $is_allowed = true;
        }

        // Subdomain detection
        if ($subdomain && in_array($subdomain, $allowed_subdomains)) {
          $is_allowed = true;
        }

        $is_valid_user = ($allowed_users[$user] ?? null) === $password;

        // Basic auth detection
        if ($user && $password && $is_valid_user) {
          $is_allowed = true;
        }


        if ($is_allowed) {
          $messageBus->dispatch(new UpdateLastAccessedAtMessage($host));
          return new Response('authorized', Response::HTTP_OK);
        }

        return new Response(
            'not authorized',
            Response::HTTP_UNAUTHORIZED,
            [
                'www-authenticate' => 'Basic realm="Identification"',
            ]
        );
    }
}
