<?php

namespace App\Controller;

use App\Service\Redis;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\Request;

class ErrorController extends AbstractController
{
    #[Route('/{req}', name: 'error', requirements: ['req' => '.*'])]
    public function index(Request $request, Redis $redis): Response
    {
        $host     = $request->getHost();
        $status   = $request->request->get('status', 404);
        $response = new Response('', $status);

        return $this->render(
            $status !== 404 || !$redis->exists($host)
                ? 'pages/error.html.twig'
                : 'pages/wait.html.twig',
            [
                'host'   => $host,
                'status' => $status,
            ],
            $response
        );
    }
}
