FROM mcr.microsoft.com/devcontainers/base:ubuntu-24.04

# Install Deno for the vscode user
USER vscode
RUN curl -fsSL https://deno.land/install.sh | sh -s -- -y
ENV DENO_DIR=/home/vscode/.deno
ENV PATH=/home/vscode/.deno/bin:${PATH}