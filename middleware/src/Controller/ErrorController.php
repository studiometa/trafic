<?php

namespace App\Controller;

use App\Service\Redis;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\Request;

class ErrorController extends AbstractController
{
    #[Route('/', name: 'error')]
    public function index(Request $request, Redis $redis): Response
    {
        $host   = $request->getHost();
        $status = $request->request->get('status', 404);

        if ($status !== 404 || !$redis->get($host)) {
            return new Response(
                sprintf('<p><b>%s</b></p><p>Oops, an error occured, try again later.</p>', $status),
                $status,
            );
        }

        return $this->render('pages/error.html.twig');
    }
}
