FROM alpine:3.19
RUN mkdir /scripts
COPY pre.sh /scripts/pre.sh
COPY main.sh /scripts/main.sh
COPY post.sh /scripts/post.sh
RUN chmod +x /scripts/pre.sh /scripts/main.sh /scripts/post.sh
