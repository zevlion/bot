## Security and Acceptable Use Policy

### 1. Cryptographic and Authentication Material Management
Contributors must ensure that all forms of authentication information, including cryptographic keys, session tokens, and user credentials, are persistently stored utilizing industry-standard encrypted storage mechanisms. Under no circumstances should raw authentication data be committed to the repository, hardcoded within the source files, or logged in plaintext outputs. All developers are required to utilize environmental variables and secure secret management utilities to handle sensitive configuration parameters.

### 2. Memory Integrity and Application Stability
Given the execution requirements of continuous messaging clients, developers must exercise rigorous memory management protocols within their contributions. Code submissions must be thoroughly evaluated to prevent memory leaks, improper resource allocation, and unchecked pointer dereferences. All submitted code must gracefully handle object lifecycle management and memory deallocation to maintain the optimal performance and availability of the software over extended operational periods.

### 3. Prohibition of Social Engineering Vectors
The architectural intent of this application is strictly to facilitate automated utility and programmatic communication. Developers and users are categorically prohibited from integrating or deploying logic designed to deceive, manipulate, or coerce individuals into divulging confidential information. Any programmatic attempt to execute phishing campaigns, pretexting, or other deceptive social engineering practices is a direct violation of the software's operational mandate.

### 4. Acceptable Operational Use and Anti-Harassment
This software interfaces directly with the WhatsApp network and its human user base, requiring operators to strictly adhere to ethical deployment guidelines. The application shall not be configured, deployed, or modified to facilitate the stalking, non-consensual monitoring, or harassment of any individual. Furthermore, utilizing the software to disseminate threats, abusive content, or unsolicited malicious payloads is strictly forbidden and actively discouraged by the project maintainers.
