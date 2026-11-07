import 'package:flutter/material.dart';

class MioFatalErrorApp extends StatelessWidget {
  const MioFatalErrorApp({required this.error, this.stack, super.key});

  final Object error;
  final StackTrace? stack;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      home: Scaffold(
        body: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 720),
            child: Padding(
              padding: const EdgeInsets.all(32),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Icon(Icons.error_outline, size: 48),
                  const SizedBox(height: 16),
                  const Text(
                    'Mio failed to start',
                    style: TextStyle(fontSize: 24, fontWeight: FontWeight.w600),
                  ),
                  const SizedBox(height: 12),
                  SelectableText('$error'),
                  if (stack != null) ...[
                    const SizedBox(height: 16),
                    const Text('Details', style: TextStyle(fontWeight: FontWeight.w600)),
                    const SizedBox(height: 4),
                    SelectableText(
                      '$stack',
                      style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
                    ),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
